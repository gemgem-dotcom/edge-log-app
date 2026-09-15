'use client'

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { queryPerformance } from '@/lib/edgeEngine'
import { strategyColor } from '@/lib/strategyColor'

// One row per strategy, with the figures a trader actually compares
// strategies on: win rate, expectancy, profit factor and sample size.
//
// Every number comes from queryPerformance (lib/edgeEngine.js), the one
// shared stats implementation the dashboard's strategy table and each
// strategy's own detail page already use - so this page cannot disagree
// with either of them. It is memoised on the trades array's identity, so
// rendering this costs nothing extra once the dashboard has run it.
//
// This is not a mobile-only component. The route it serves renders at any
// width; it is simply not linked from the desktop sidebar, which has its
// own expandable strategy list.

function fmtPct(v) {
  return v === null || v === undefined ? '—' : `${v.toFixed(1)}%`
}

function fmtR(v) {
  return v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`
}

// Infinity is a real result here, not an error: profitFactor is
// grossWin/grossLoss, so a strategy that has never had a losing trade
// divides by zero. "∞" states that honestly; toFixed(2) would render
// "Infinity" and a null check would hide a perfect record.
function fmtPF(v) {
  if (v === null || v === undefined) return '—'
  return Number.isFinite(v) ? v.toFixed(2) : '∞'
}

export default function StrategyList({
  strategies = [],
  trades = [],
  // One page-level symbol (a single instrument's page), OR a resolver
  // when each row belongs to a different instrument (the all-instruments
  // page). A strategy id only means anything under the instrument that
  // owns it, so a row that cannot resolve one is rendered as plain text
  // rather than as a link to /app/undefined/strategies/<id>.
  symbol = null,
  symbolFor = null,
  showInstrument = false,
  colorIndexById = {},
  unclassifiedCount = 0,
}) {
  const rows = queryPerformance({ trades, groupBy: 'strategy_id' })
  const statsById = {}
  for (const row of rows) statsById[row.key] = row

  return (
    <div className="panel">
      <div className="m-strategy-index-head" aria-hidden="true">
        <span>Strategy</span>
        <span>All-time</span>
      </div>

      <ul className="m-strategy-index">
        {strategies.map((s) => {
          const rowSymbol = symbolFor ? symbolFor(s) : symbol
          // A strategy with no CLOSED trades has no row in the stats
          // output at all - queryPerformance skips groups nobody has
          // traded rather than padding a "0 trades" row in. So the
          // absence has to be handled here rather than assumed away.
          const st = statsById[s.id]
          const href = rowSymbol ? `/app/${rowSymbol}/strategies/${s.id}` : null
          const body = (
              <>
                {/* Same colour, keyed the same way, as the sidebar and the
                    dashboard's strategy table - creation order, per
                    strategyColor's own header. */}
                <span className="strategy-dot" style={{ background: strategyColor(colorIndexById[s.id]) }} />
                <span className="m-strategy-index-body">
                  <span className="m-strategy-index-name">
                    {s.name}
                    {showInstrument && rowSymbol ? <span className="m-strategy-index-inst">{rowSymbol}</span> : null}
                  </span>
                  {st ? (
                    <span className="m-strategy-index-stats">
                      <span>Win<b>{fmtPct(st.winRate)}</b></span>
                      <span>Exp<b className={st.expectancy > 0 ? 'pnl-pos' : st.expectancy < 0 ? 'pnl-neg' : ''}>{fmtR(st.expectancy)}</b></span>
                      <span>PF<b>{fmtPF(st.profitFactor)}</b></span>
                      <span>n<b>{st.n}</b></span>
                    </span>
                  ) : (
                    <span className="m-strategy-index-stats">No closed trades yet</span>
                  )}
                </span>
                <ChevronRight size={16} className="m-strategy-index-chevron" />
              </>
          )
          return (
            <li key={s.id}>
              {href ? (
                <Link href={href} className="m-strategy-index-row">{body}</Link>
              ) : (
                <span className="m-strategy-index-row">{body}</span>
              )}
            </li>
          )
        })}

        {/* Unassigned is not a strategy and has no detail page, so it
            links to the trade log filtered on it - the same deep link the
            dashboard's own unclassified note uses. Shown only when there
            is something to show. */}
        {unclassifiedCount > 0 && symbol ? (
          <li>
            <Link href={`/app/${symbol}/log?strategy=unclassified`} className="m-strategy-index-row">
              <span className="strategy-dot" style={{ background: 'var(--muted-2)' }} />
              <span className="m-strategy-index-body">
                <span className="m-strategy-index-name">Unassigned</span>
                <span className="m-strategy-index-stats">
                  {unclassifiedCount} trade{unclassifiedCount === 1 ? '' : 's'} · not counted until reassigned
                </span>
              </span>
              <ChevronRight size={16} className="m-strategy-index-chevron" />
            </Link>
          </li>
        ) : null}
      </ul>
    </div>
  )
}
