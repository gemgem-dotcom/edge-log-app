#!/usr/bin/env python3
"""One-time, locally-run backfill of market_session_stats from an
already-downloaded Databento DBN file - not part of the deployed app, not a
route, not scheduled anywhere. Seeds a trailing-20-session baseline
immediately from history you already have, instead of waiting a month for
scripts/fetch-daily-market-stats.js's daily job to accumulate it on its own.

Uses Databento's own official Python client (`databento`) to decode the DBN
file - this script never attempts to parse the binary format itself.

Groups bars by CME trading day the same way scripts/fetch-daily-market-
stats.js does (a session runs 6pm ET the prior calendar day through that
day's close, not a plain calendar day) - reimplemented here in Python since
that script is intentionally standalone JS with no shared module to import
from (see its own header comment for why), but the boundary rule itself is
the same one lib/marketHours.js's computeOpen and that script both use.

Usage:
    pip install databento requests
    DATABENTO_DBN_FILE=/path/to/your/file.dbn.zst \
    SUPABASE_SERVICE_ROLE_KEY=... \
    NEXT_PUBLIC_SUPABASE_URL=... \
    python3 scripts/backfill_market_stats_from_dbn.py

Env vars (all required except noted):
    DATABENTO_DBN_FILE          path to the downloaded .dbn/.dbn.zst file
    SUPABASE_SERVICE_ROLE_KEY   same value as .env.local's / the GitHub
                                 Actions secret - needed to write past RLS
    NEXT_PUBLIC_SUPABASE_URL    same value as .env.local's

DATABENTO_API_KEY is deliberately NOT required here - decoding an
already-downloaded DBN file is a pure local file read with no network call,
unlike lib/databento.js/scripts/fetch-daily-market-stats.js's HTTP calls to
Databento's Historical API, which do need it.
"""
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import databento as db
import requests

DATA_SYMBOL = 'NQ'
ET = ZoneInfo('America/New_York')


def load_holidays():
    path = Path(__file__).parent.parent / 'lib' / 'cmeHolidays.json'
    import json
    with open(path) as f:
        return json.load(f)


def session_date_for(ts_utc):
    """The CME trading-day a UTC bar timestamp belongs to - 6pm ET or later
    rolls forward into the next calendar day's session, same rule
    lib/marketHours.js's computeOpen and scripts/fetch-daily-market-stats.js
    both use for the "day starts at the prior evening" convention."""
    ts_et = ts_utc.tz_convert(ET)
    d = ts_et.date()
    if ts_et.hour >= 18:
        d = d + timedelta(days=1)
    return d


def existing_session_dates(supabase_url, headers):
    resp = requests.get(
        f'{supabase_url}/rest/v1/market_session_stats',
        params={'select': 'session_date', 'data_symbol': f'eq.{DATA_SYMBOL}'},
        headers=headers,
    )
    resp.raise_for_status()
    return {row['session_date'] for row in resp.json()}


def main():
    dbn_path = os.environ.get('DATABENTO_DBN_FILE')
    supabase_url = os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not dbn_path or not supabase_url or not service_key:
        print('DATABENTO_DBN_FILE, NEXT_PUBLIC_SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY must all be set.', file=sys.stderr)
        sys.exit(1)

    headers = {
        'apikey': service_key,
        'Authorization': f'Bearer {service_key}',
        'Content-Type': 'application/json',
    }

    print(f'Reading {dbn_path} ...')
    store = db.DBNStore.from_file(dbn_path)
    df = store.to_df()  # pretty_px/pretty_ts defaults give real floats and tz-aware UTC timestamps
    print(f'Loaded {len(df)} bars spanning {df.index.min()} to {df.index.max()}')

    df['session_date'] = [session_date_for(ts) for ts in df.index]

    holidays = load_holidays()
    existing = existing_session_dates(supabase_url, headers)
    print(f'{len(existing)} NQ session_date rows already present - these will be skipped, not overwritten.')

    rows = []
    skipped_weekend = 0
    skipped_holiday = 0
    skipped_existing = 0

    for session_date, group in df.groupby('session_date'):
        ds = session_date.isoformat()

        if session_date.weekday() >= 5:  # Saturday/Sunday - no real CME session lands here
            skipped_weekend += 1
            continue
        if holidays.get(ds, {}).get('type') == 'closed':
            skipped_holiday += 1
            continue
        if ds in existing:
            skipped_existing += 1
            continue

        total_range = float(group['high'].max() - group['low'].min())
        total_volume = float(group['volume'].sum())
        rows.append({
            'data_symbol': DATA_SYMBOL,
            'session_date': ds,
            'total_range': total_range,
            'total_volume': total_volume,
        })

    print(f'Skipped: {skipped_weekend} weekend buckets, {skipped_holiday} full holidays, {skipped_existing} already in the table.')
    print(f'Upserting {len(rows)} new rows...')

    if rows:
        resp = requests.post(
            f'{supabase_url}/rest/v1/market_session_stats',
            params={'on_conflict': 'data_symbol,session_date'},
            headers={**headers, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
            json=rows,
        )
        if not resp.ok:
            print(f'Supabase upsert failed: {resp.status_code} {resp.text}', file=sys.stderr)
            sys.exit(1)

    total_now = len(existing_session_dates(supabase_url, headers))
    print(f'Done. market_session_stats now has {total_now} NQ rows total.')


if __name__ == '__main__':
    main()
