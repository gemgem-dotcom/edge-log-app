#!/usr/bin/env bash
# Runs the full strategy search against a VERIFIED martingale (see
# scripts/_stub-random-walk.js) and asserts it finds nothing.
#
# This is the regression guard for the search's honesty. Any lookahead - a
# signal reading its own bar, an indicator peeking forward, a null that stops
# matching the rule it is judging - shows up here as survivors on data that
# provably has no edge. Three separate versions of this search reported z > 4
# on noise before the null was matched on volatility regime; without this
# check, all three would have looked like discoveries.
#
# Asserts on the survivor count rather than the exit status, because the
# search exits 0 whether it finds an edge or not.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "verifying the control generator is actually a martingale..."
node scripts/_stub-random-walk.js || { echo "FAIL: control generator has serial correlation"; exit 1; }

fails=0
# Several disjoint synthetic samples: one clean run could be luck.
for range in "2026-01-05 2026-04-30 2026-04-01" "2025-02-03 2025-06-30 2025-06-01"; do
  set -- $range
  out=$(SCAN_START_DATE=$1 SCAN_END_DATE=$2 HOLDOUT_START_DATE=$3 \
        DATABENTO_API_KEY=stub \
        node --require ./scripts/_stub-random-walk.js scripts/search-strategies.js 2>/dev/null \
        | grep '^EXPLORATION_SUMMARY:' | sed 's/^EXPLORATION_SUMMARY://')

  if [ -z "$out" ]; then
    echo "FAIL [$1]: search produced no summary line"
    fails=$((fails + 1))
    continue
  fi

  survivors=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).survivors))" "$out")
  cells=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).cellsScored))" "$out")
  bestZ=$(node -e "process.stdout.write(Number(JSON.parse(process.argv[1]).bestZ).toFixed(2))" "$out")

  if [ "$cells" -lt 100 ]; then
    echo "FAIL [$1]: only $cells cells scored - the search is not actually running"
    fails=$((fails + 1))
  elif [ "$survivors" -ne 0 ]; then
    echo "FAIL [$1]: $survivors survivor(s) on a martingale (best z=$bestZ) - there is lookahead somewhere"
    fails=$((fails + 1))
  else
    echo "ok [$1]: $cells cells, 0 survivors, best z=$bestZ"
  fi
done

if [ "$fails" -ne 0 ]; then
  echo "control FAILED - do not trust any result this search produces"
  exit 1
fi
echo "control ok - the search finds no edge in data that has none"
