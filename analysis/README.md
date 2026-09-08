# Blind case review

## Why this exists

Everything up to this point tried to recover the rule behind the logged HVZ
REJECTION trades from the trades themselves. That cannot work, and it is worth
being precise about why: the journal holds 24 entries that were *taken*. It
holds no record of the setups that were looked at and passed on. A decision
rule is a boundary between take and pass, and a boundary cannot be located from
points on one side of it.

The mechanical version of the rule — rest a limit at the centre of the 5m POC
(270 lookback, 25 rows, all hours) — has been tested across a year and is close
to a coin flip. Restricted to 09:30–11:30 ET it beats a random walk in 51 of 98
(stop, target) cells with a median of +0.22 percentage points, which is inside
one standard error. The logged trades win 57.9%. So the selection sitting
between "the level filled" and "the trade was taken" is doing the work, and
that selection is not in any price series.

This asks for it directly.

## Protocol

`case-review-blind.json` holds 20 dates and times, nothing else. Each one is a
minute at which a resting limit at the 5m POC centre would have filled, inside
the 09:35–11:30 ET window (the first five minutes are excluded — those are
already a stated pass).

For each case: pull it up on the chart, look at it the way it would be looked
at live, and record **take or pass** plus one line of why. Then the key is
opened.

What the answers are for:
- The **pass** cases are the half of the data that has never existed.
- The **why** lines are the candidate feature list — anything named there can
  be measured against the full year of scanned fills.
- Take/pass against outcome gives a direct read on whether the selection is
  real, before any further slicing of the price data.

## Fairness of the sample

- Stratified 7 "ran" / 6 "stopped fast" / 7 "went nowhere", then shuffled. The
  order carries no information and neither does the mix.
- One case per date, so no case can be inferred from a neighbour.
- Exploration set only (through 2026-06-04). The 2026-06-06 → 2026-09-05
  holdout stays sealed.

Outcome classes are measured against a 3×ATR(1m) stop, read off the excursion
grid the scan already records: *ran* reached ≥100 points favourable before that
stop, *stopped fast* touched the stop within 12 bars with little favourable
movement first, *went nowhere* is everything else.

## Files

| file | what it is |
| --- | --- |
| `build-case-review.js` | regenerates both files from a scan event dump |
| `case-review-blind.json` | the 20 cases — date and time only |
| `case-review-key.b64` | direction, entry, outcome class, points, stop bar |

The key is base64 so it cannot be read by accident while the review is open.
It is not a secret — `base64 -d analysis/case-review-key.b64` prints it — it
just should not be glanced at before the answers are in.

Regenerate with:

```
node analysis/build-case-review.js <scan-events.json> analysis
```

The seed is fixed, so the same event dump always produces the same 20 cases.
