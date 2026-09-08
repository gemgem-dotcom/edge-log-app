#!/usr/bin/env bash
# End-to-end smoke test for scan-rejection-conditions.js against synthetic
# bars (scripts/_stub-databento.js), so the real event loop runs with no
# Databento key.
#
# It ASSERTS rather than just exiting 0. That matters: the scan swallows
# per-day errors in a try/catch and logs "<date> failed: ...", so a
# ReferenceError still exits 0 while producing zero events. Exactly that
# shipped once - a rewrite referenced a variable it had deleted, `node -c`
# passed, lint passed, and it burned a 20-minute Actions job reporting
# "285 days failed" before anyone saw it.
set -uo pipefail
OUT=$(mktemp); ERR=$(mktemp)
trap 'rm -f "$OUT" "$ERR"' EXIT

DATABENTO_API_KEY=stub INSTRUMENT_SYMBOL=NQ \
SCAN_START_DATE=2026-04-01 SCAN_END_DATE=2026-04-30 \
  node --require ./scripts/_stub-databento.js scripts/scan-rejection-conditions.js > "$OUT" 2> "$ERR"

FAILED=$(grep -c "failed:" "$ERR" || true)
EVENTS=$(grep -c "^EVENT:" "$OUT" || true)

if [ "$FAILED" -ne 0 ]; then
  echo "SMOKE FAIL: $FAILED day(s) errored. First:"
  grep -m3 "failed:" "$ERR"
  exit 1
fi
if [ "$EVENTS" -lt 10 ]; then
  echo "SMOKE FAIL: only $EVENTS events produced (expected >=10)"
  exit 1
fi
echo "smoke ok - $EVENTS events, 0 day failures"
