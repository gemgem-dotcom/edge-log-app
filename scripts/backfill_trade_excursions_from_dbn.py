#!/usr/bin/env python3
"""One-time, locally-run backfill of MFE/MAE/drawdown_seconds for trades
logged before the live per-trade fetch mechanism existed (app/api/
backfill-trade-excursion/route.js, scripts/retry-trade-excursions.js - see
schema.sql's comment above `mfe_points` and NOTES.md for the full picture).
Not part of the deployed app, not a route, not scheduled - same shape as
scripts/backfill_market_stats_from_dbn.py, the earlier one-time DBN
backfill this mirrors.

Formulas mirror lib/tradeExcursions.js's excursionWindow/computeExcursion
exactly (window = entry to final exit, walking each additional_exits leg
with the same day-wrap rule; MFE/MAE and per-bar drawdown via each bar's
high/low, not closes) - re-implemented here rather than imported, since
decoding a DBN file needs Databento's official Python client (there's no
official Node/JS one - see lib/databento.js's own header comment) while
the live path is JS; a literal shared function can't cross that language
boundary. BAR_SECONDS is 1 here, not 60 like the live path's ohlcv-1m bars,
because this file is ohlcv-1s - the one formula constant that's genuinely
different between the two paths, not a copy that drifted.

The entry/exit boundaries fed into compute_excursion are not the raw
logged trade_time/exit_time - see find_fill_instant/derive_fill_instants
below (mirroring lib/tradeExcursions.js's own findFillInstant/
deriveFillInstants) for why a logged second is not trustworthy enough to
use directly and what's derived instead.

Scope, deliberately narrower than the rest of this codebase's usual
data_symbol('NQ') grouping (which treats NQ and MNQ as the same
underlying series for market-data purposes): this backfill matches on the
trade's own instruments.symbol being exactly 'NQ', not data_symbol. Any
MNQ (or other) trade is left completely untouched, regardless of date -
per the brief this shipped under, confirmed by inspecting the actual
instrument symbols in use before writing anything (see the printed
"Other instrument symbols present" line below).

Like the file's own front-month contamination problem already solved in
scripts/backfill_market_stats_from_dbn.py (requested with stype_in=
'parent', so it contains every NQ contract month and every calendar
spread mixed together): this script reuses that same day-level "whichever
contract traded the most volume that session is the front month" lookup,
built once from the whole file, so a trade's narrow entry-exit window is
sliced from the correct contract's own bars, not whatever happens to be
in the file for that time range across every month/spread at once.

Usage:
    pip install databento requests
    DATABENTO_DBN_FILE=/path/to/your/file.dbn.zst \
    SUPABASE_SERVICE_ROLE_KEY=... \
    NEXT_PUBLIC_SUPABASE_URL=... \
    python3 scripts/backfill_trade_excursions_from_dbn.py

Env vars (all required):
    DATABENTO_DBN_FILE          path to the downloaded .dbn/.dbn.zst file
    SUPABASE_SERVICE_ROLE_KEY   same value as .env.local's / the GitHub
                                 Actions secret - needed to write past RLS
    NEXT_PUBLIC_SUPABASE_URL    same value as .env.local's

DATABENTO_API_KEY is deliberately NOT required - decoding an
already-downloaded DBN file is a pure local read, no network call.
"""
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import databento as db
import requests

EXACT_SYMBOL = 'NQ'  # instruments.symbol, not data_symbol - see file header
BAR_SECONDS = 1  # ohlcv-1s
ET = ZoneInfo('America/New_York')


def wall_clock_to_instant(date_str, time_str, offset_hours):
    """Mirrors lib/tradeSessions.js's wallClockToInstant: trade_date/
    trade_time is a wall-clock reading, not a real instant, until combined
    with the account's own saved UTC offset."""
    if not date_str or not time_str:
        return None
    y, mo, d = (int(x) for x in date_str.split('-'))
    parts = time_str.split(':')
    hh, mm = int(parts[0]), int(parts[1])
    ss = int(parts[2]) if len(parts) > 2 else 0
    naive_utc = datetime(y, mo, d, hh, mm, ss, tzinfo=ZoneInfo('UTC'))
    return naive_utc - timedelta(hours=offset_hours)


def add_one_day(date_str):
    y, mo, d = (int(x) for x in date_str.split('-'))
    return (datetime(y, mo, d) + timedelta(days=1)).strftime('%Y-%m-%d')


def excursion_window(trade, offset_hours):
    """Mirrors lib/tradeExcursions.js's excursionWindow exactly - entry to
    the *final* exit, walking the primary exit then each additional_exits
    leg in order, rolling to the next calendar day whenever an exit's
    clock time is earlier than the previous instant's. Returns a dict with
    `legs` (each exit's own raw {price, instant}) alongside entry_instant/
    exit_instant, same shape as that file's own return value - each leg's
    own raw instant is what find_fill_instant below anchors its search on,
    not just the final exit_instant."""
    if not trade.get('trade_date') or not trade.get('trade_time') or offset_hours is None:
        return None
    entry_instant = wall_clock_to_instant(trade['trade_date'], trade['trade_time'], offset_hours)
    if entry_instant is None:
        return None

    exit_legs = [{'price': trade.get('exit_price'), 'time': trade.get('exit_time')}] + [
        {'price': e.get('exit_price'), 'time': e.get('exit_time')} for e in (trade.get('additional_exits') or [])
    ]
    exit_legs = [leg for leg in exit_legs if leg['time']]
    if not exit_legs:
        return None

    current_date = trade['trade_date']
    current_instant = entry_instant
    legs = []
    for leg in exit_legs:
        instant = wall_clock_to_instant(current_date, leg['time'], offset_hours)
        if instant < current_instant:
            current_date = add_one_day(current_date)
            instant = wall_clock_to_instant(current_date, leg['time'], offset_hours)
        current_instant = instant
        legs.append({'price': leg['price'], 'instant': instant})

    return {'entry_instant': entry_instant, 'legs': legs, 'exit_instant': legs[-1]['instant']}


# See lib/tradeExcursions.js's FILL_SEARCH_PAD_MINUTES/findFillInstant/
# deriveFillInstants/sliceBarsForWindow for the full explanation - this is
# the same logic, reimplemented rather than imported (this file can't
# import a JS module - see the file header). Unlike the JS live/retry
# path's ohlcv-1m bars, this file's bars are ohlcv-1s, decoded through the
# official Python client's own DataFrame index rather than a hand-parsed
# ts_event - so there's no analog here of lib/tradeExcursions.js's
# parseBarInstant uncertainty, and the search resolves to the actual
# second within the winning minute, not just the minute itself. A real
# precision difference between the two paths, driven by the data each
# already fetches, not a rule mismatch - both still search the logged
# minute first, then the minute immediately before and after, in that
# order, and both fall back to the raw instant on a total miss.
FILL_SEARCH_PAD_MINUTES = 2
FILL_PRICE_EPSILON = 0.0001


def bar_touches_price(row, price):
    return row['low'] - FILL_PRICE_EPSILON <= price <= row['high'] + FILL_PRICE_EPSILON


def minute_bucket_start(ts, minute_offset):
    return (ts + timedelta(minutes=minute_offset)).replace(second=0, microsecond=0)


def find_fill_instant(bars, rough_instant, price):
    for minute_offset in (0, -1, 1):
        bucket_start = minute_bucket_start(rough_instant, minute_offset)
        bucket_end = bucket_start + timedelta(minutes=1)
        candidates = bars[(bars.index >= bucket_start) & (bars.index < bucket_end)].sort_index()
        for ts, row in candidates.iterrows():
            if bar_touches_price(row, price):
                return ts, True
    return rough_instant, False


def derive_fill_instants(raw_window, entry_price, bars):
    entry_instant, matched = find_fill_instant(bars, raw_window['entry_instant'], entry_price)
    used_fallback = not matched
    last_instant = entry_instant

    for leg in raw_window['legs']:
        leg_instant, matched = find_fill_instant(bars, leg['instant'], leg['price'])
        if not matched:
            used_fallback = True
        last_instant = leg_instant

    return entry_instant, last_instant, used_fallback


def session_date_for(ts_utc):
    """Same CME-trading-day rule scripts/backfill_market_stats_from_dbn.py
    already uses: 6pm ET or later rolls into the next calendar day's
    session. Used only to look up each bar's own front-month contract,
    not to bucket trades by day."""
    ts_et = ts_utc.astimezone(ET)
    d = ts_et.date()
    if ts_et.hour >= 18:
        d = d + timedelta(days=1)
    return d


EXIT_LEVEL_EPSILON = 0.0001


def compute_excursion(bars, entry, direction, stop=None, target=None, exit_price=None):
    """Mirrors lib/tradeExcursions.js's computeExcursion: MFE/MAE and
    per-bar drawdown via each bar's high/low (not closes), summing every
    separate underwater run of bars rather than just the first.

    MFE/MAE are capped at the trade's own target/stop whenever the trade's
    final exit leg (exit_price) actually landed on that level - a stop-loss
    or take-profit order closes the position the instant price reaches it,
    so anything a 1-minute bar's high/low shows beyond that level for the
    same minute is intra-bar movement the trade was never actually exposed
    to. See lib/tradeExcursions.js's own copy of this function for the full
    explanation."""
    highs = bars['high'].tolist()
    lows = bars['low'].tolist()
    max_high = max(highs)
    min_low = min(lows)

    hit_stop = stop is not None and exit_price is not None and abs(exit_price - stop) <= EXIT_LEVEL_EPSILON
    hit_target = target is not None and exit_price is not None and abs(exit_price - target) <= EXIT_LEVEL_EPSILON

    if direction == 'long':
        raw_mfe = max_high - entry
        raw_mae = entry - min_low
    else:
        raw_mfe = entry - min_low
        raw_mae = max_high - entry

    mfe_points = abs(target - entry) if hit_target else raw_mfe
    mae_points = abs(stop - entry) if hit_stop else raw_mae

    underwater_bars = 0
    for high, low in zip(highs, lows):
        underwater = (low < entry) if direction == 'long' else (high > entry)
        if underwater:
            underwater_bars += 1

    return mfe_points, mae_points, underwater_bars * BAR_SECONDS


def get_user_timezone(supabase_url, headers, user_id, cache):
    if user_id in cache:
        return cache[user_id]
    r = requests.get(f'{supabase_url}/auth/v1/admin/users/{user_id}', headers=headers)
    offset = None
    if r.ok:
        tz = (r.json() or {}).get('user_metadata', {}).get('timezone')
        try:
            offset = float(tz)
        except (TypeError, ValueError):
            offset = None
    cache[user_id] = offset
    return offset


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
    df = store.to_df()
    df = df.sort_index()
    file_start = df.index.min()
    file_end = df.index.max()
    print(f'Loaded {len(df)} bars spanning {file_start} to {file_end}')

    before = len(df)
    outright = df[~df['symbol'].str.contains('-')].copy()  # drop calendar spreads
    print(f'Dropped {before - len(outright)} calendar-spread bars, {len(outright)} outright-contract bars remain ({outright["symbol"].nunique()} contract months).')

    outright['session_date'] = [session_date_for(ts) for ts in outright.index]
    # Whichever contract traded the most volume each session is that
    # session's front month - same methodology already proven against
    # this exact file in scripts/backfill_market_stats_from_dbn.py.
    front_month_by_date = outright.groupby('session_date').apply(lambda g: g.groupby('symbol')['volume'].sum().idxmax())

    # Confirm before running, per the brief: what instrument symbols
    # actually exist on logged trades, so an MNQ (or other) trade is
    # visibly, deliberately excluded rather than silently skipped.
    r = requests.get(f'{supabase_url}/rest/v1/instruments', params={'select': 'id,symbol'}, headers=headers)
    r.raise_for_status()
    instruments = r.json()
    other_symbols = sorted({i['symbol'] for i in instruments if i['symbol'] != EXACT_SYMBOL})
    if other_symbols:
        print(f'Other instrument symbols on this account (excluded from this backfill regardless of date): {other_symbols}')

    nq_instruments = [i for i in instruments if i['symbol'] == EXACT_SYMBOL]
    if not nq_instruments:
        print(f'No instrument with symbol exactly "{EXACT_SYMBOL}" - nothing to do.')
        return
    nq_ids = [i['id'] for i in nq_instruments]

    r = requests.get(f'{supabase_url}/rest/v1/trades',
                      params={'select': '*', 'instrument_id': f'in.({",".join(nq_ids)})'},
                      headers=headers)
    r.raise_for_status()
    trades = r.json()
    print(f'{len(trades)} trade(s) on symbol "{EXACT_SYMBOL}".')

    updated = 0
    updated_with_fallback = 0
    skipped_already_complete = 0
    skipped_no_window = 0
    skipped_truncated = 0
    skipped_no_bars = 0
    tz_cache = {}
    pad = timedelta(minutes=FILL_SEARCH_PAD_MINUTES)

    for trade in trades:
        if trade.get('market_data_status') == 'complete':
            skipped_already_complete += 1
            continue

        offset_hours = get_user_timezone(supabase_url, headers, trade['user_id'], tz_cache)
        raw_window = excursion_window(trade, offset_hours) if offset_hours is not None else None
        if raw_window is None:
            skipped_no_window += 1
            continue

        # A window that pokes even slightly past either edge of the file's
        # actual coverage is a truncated read, not a complete one - would
        # understate MFE/MAE rather than reflect what really happened.
        # Checked against the raw (unpadded) window, same as before this
        # fix - the padding below is a fill-instant search margin, not a
        # widening of what counts as "in scope."
        if raw_window['entry_instant'] < file_start or raw_window['exit_instant'] > file_end:
            skipped_truncated += 1
            continue

        padded_bars = outright.loc[raw_window['entry_instant'] - pad:raw_window['exit_instant'] + pad]
        padded_bars = padded_bars[padded_bars['symbol'] == padded_bars['session_date'].map(front_month_by_date)]

        entry_instant, exit_instant, used_fallback = derive_fill_instants(raw_window, trade['entry'], padded_bars)
        window_bars = padded_bars.loc[entry_instant:exit_instant]
        if len(window_bars) == 0:
            skipped_no_bars += 1
            continue

        final_exit_price = raw_window['legs'][-1]['price']
        mfe_points, mae_points, drawdown_seconds = compute_excursion(
            window_bars, trade['entry'], trade['direction'],
            stop=trade.get('stop'), target=trade.get('target'), exit_price=final_exit_price,
        )
        patch = requests.patch(f'{supabase_url}/rest/v1/trades',
                                params={'id': f'eq.{trade["id"]}'},
                                headers=headers,
                                json={
                                    'mfe_points': mfe_points,
                                    'mae_points': mae_points,
                                    'drawdown_seconds': drawdown_seconds,
                                    'market_data_status': 'complete',
                                    'excursion_fallback': used_fallback,
                                })
        if not patch.ok:
            print(f'Update failed for trade {trade["id"]}: {patch.status_code} {patch.text}', file=sys.stderr)
            continue
        updated += 1
        if used_fallback:
            updated_with_fallback += 1
        fallback_note = ' [fallback timestamp used]' if used_fallback else ''
        print(f'  {trade["id"]}: mfe={mfe_points:.2f} mae={mae_points:.2f} drawdown={drawdown_seconds}s{fallback_note}')

    print()
    print(f'Updated: {updated} (of which {updated_with_fallback} used a fallback timestamp for at least one leg)')
    print(f'Skipped - already complete: {skipped_already_complete}')
    print(f'Skipped - no timezone/exit window: {skipped_no_window}')
    print(f'Skipped - window truncated at file edge: {skipped_truncated}')
    print(f'Skipped - no bars found for window: {skipped_no_bars}')


if __name__ == '__main__':
    main()
