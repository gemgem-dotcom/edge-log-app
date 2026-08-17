#!/usr/bin/env python3
"""Regenerates lib/cmeHolidays.json from pandas_market_calendars' CME_Equity
calendar - the real, actively maintained source for CME-specific holiday and
early-close rules (not just a copy of NYSE's calendar). Run this by hand
roughly once a year (holiday schedules are published a year in advance and
barely change) - there's no live API for this and no runtime Python
dependency in the app itself, this script just produces a static JSON file.

Usage:
    pip install pandas_market_calendars
    python3 scripts/generate_cme_holidays.py

Writes lib/cmeHolidays.json covering the current year through next year.
"""
import json
import os
from datetime import date

import pandas as pd
import pandas_market_calendars as mcal

START_YEAR = date.today().year
END_YEAR = START_YEAR + 1

# The library's own rule names are otherwise used verbatim (they're accurate
# holiday names) - these two are display cleanups only, not corrections to
# the underlying rule: a missing apostrophe, and a rule name that includes
# its own effective-year caveat, which reads as a typo/confusing date rather
# than a holiday name once it's sitting in the pill or the notice banner.
NAME_OVERRIDES = {
    'New Years Day': "New Year's Day",
    'Juneteenth Starting at 2022': 'Juneteenth',
}

def display_name(raw_name):
    return NAME_OVERRIDES.get(raw_name, raw_name)

def main():
    cal = mcal.get_calendar('CME_Equity')
    start = f'{START_YEAR}-01-01'
    end = f'{END_YEAR}-12-31'

    schedule = cal.schedule(start_date=start, end_date=end)
    close_et = schedule['market_close'].dt.tz_convert('America/New_York')

    # Every regular calendar weekday in range, so days missing from the
    # schedule entirely (full closures) can be found by set difference.
    all_weekdays = {
        d.strftime('%Y-%m-%d') for d in pd.date_range(start, end, freq='D') if d.weekday() < 5
    }
    trading_days = set(schedule.index.strftime('%Y-%m-%d'))
    fully_closed_dates = sorted(all_weekdays - trading_days)

    # Early closes: a trading day whose real ET close time isn't the normal
    # 17:00 - comparing local ET time (not raw UTC) so EST/EDT don't get
    # mistaken for a shortened session.
    early_close_dates = {}
    for ts, close in close_et.items():
        if close.strftime('%H:%M') != '17:00':
            early_close_dates[ts.strftime('%Y-%m-%d')] = close.strftime('%H:%M')

    # Names: regular_holidays.rules covers full closures (New Year's,
    # Christmas); special_closes pairs a close time with an
    # AbstractHolidayCalendar whose rules cover the early-close days
    # (Good Friday, MLK Day, Thanksgiving, Black Friday, etc).
    holidays = {}

    for rule in cal.regular_holidays.rules:
        for d in rule.dates(start, end):
            ds = d.strftime('%Y-%m-%d')
            if ds in fully_closed_dates:
                holidays[ds] = {'type': 'closed', 'name': display_name(rule.name)}

    for close_time, holcal in cal.special_closes:
        for rule in holcal.rules:
            for d in rule.dates(start, end):
                ds = d.strftime('%Y-%m-%d')
                if ds in early_close_dates:
                    holidays[ds] = {
                        'type': 'early_close',
                        'name': display_name(rule.name),
                        'closeTime': early_close_dates[ds],
                    }

    # Anything left over (found by the schedule diff but not matched to a
    # named rule above) still gets recorded, generically named, rather than
    # silently dropped - better to show an unnamed real closure than none.
    for ds in fully_closed_dates:
        holidays.setdefault(ds, {'type': 'closed', 'name': 'Market holiday'})
    for ds, close_hm in early_close_dates.items():
        holidays.setdefault(ds, {'type': 'early_close', 'name': 'Early close', 'closeTime': close_hm})

    ordered = dict(sorted(holidays.items()))

    out_path = os.path.join(os.path.dirname(__file__), '..', 'lib', 'cmeHolidays.json')
    with open(out_path, 'w') as f:
        json.dump(ordered, f, indent=2)
        f.write('\n')

    print(f'Wrote {len(ordered)} entries to {out_path}')

if __name__ == '__main__':
    main()
