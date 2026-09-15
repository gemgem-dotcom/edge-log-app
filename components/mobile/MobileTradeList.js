'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, SlidersHorizontal, Pencil } from 'lucide-react'
import { hasResult } from '@/lib/tradeMath'

// The trade log, as a phone actually wants it.
//
// This replaces TradeLogTable below the mobile breakpoint, and it exists
// because the table did not merely look cramped there - it HID THE DATA.
// At 390px the eight columns collapsed to three (Date, Day, Strategy),
// with the strategy name itself truncated mid-word, and direction, entry,
// exit, R-multiple and P&L were simply not reachable. A trading journal
// whose numbers are invisible on the device the trader carries is not a
// journal on that device at all.
//
// The shape is a card per trade rather than a row, because the things a
// trader scans for - did it win, by how much, on which strategy - are
// three different kinds of value and a phone has room to stack them but
// not to column them.
//
// Every class here is prefixed `m-` and every rule for them lives inside
// the mobile media query, so none of this can reach the desktop table.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtPnl(value) {
  if (value === null || value === undefined) return null
  const sign = value >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtNum(value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtR(value) {
  if (value === null || value === undefined) return null
  return `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}R`
}

// "Thu 5 Feb" - the day name earns its place on mobile because the
// desktop's separate Day column has nowhere to go, and weekday is a real
// dimension a trader filters on.
function fmtDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

// win / loss / breakeven / open, keyed off the SAME thing the desktop
// table keys off: hasResult, i.e. r_multiple being non-null.
//
// This was written against exit_price first, which looks equivalent and
// is not. CLAUDE.md is explicit that r_multiple stays nullable because
// rows predating the mandatory-exit rule may hold null - so a legacy row
// with an exit price but no R read as 'breakeven' here and 'Open' on
// desktop, and disagreed with the server-side filter too, which maps
// breakeven to r_multiple = 0 (lib/tradeQuery.js). Two views of one row,
// which is the exact class of bug this repo has been bitten by before.
function resultOf(trade) {
  if (!hasResult(trade)) return 'open'
  if (trade.r_multiple > 0) return 'win'
  if (trade.r_multiple < 0) return 'loss'
  return 'breakeven'
}

// The Edit link needs an instrument in its path, and the all-instruments
// log has no page-level symbol - each row belongs to a different one. So
// the row's own symbol wins, the page's is the fallback, and when there
// is neither the link is not rendered at all rather than pointing at
// /app/null/log/<id>/edit. A dead link is worse than a missing one, and
// that exact mistake shipped once already in this work (the Strategies
// tab, which 404'd).
function editHrefFor(trade, symbol, instrumentSymbol) {
  const s = instrumentSymbol || symbol
  return s ? `/app/${s}/log/${trade.id}/edit` : null
}

function TradeCard({ trade, strategyName, symbol, instrumentSymbol, showStrategy }) {
  const [open, setOpen] = useState(false)
  const result = resultOf(trade)
  const editHref = editHrefFor(trade, symbol, instrumentSymbol)
  const pnl = fmtPnl(trade.pnl)
  const r = fmtR(trade.r_multiple)

  const exitLegs = [
    { exit_time: trade.exit_time, exit_price: trade.exit_price, contracts: trade.contracts },
    ...(trade.additional_exits || []),
  ]
  const multiExit = exitLegs.length > 1
  const totalContracts = exitLegs.reduce((sum, leg) => sum + (leg.contracts == null ? 0 : Number(leg.contracts)), 0)

  return (
    <li className={`m-trade-card is-${result}`}>
      {/* The whole header is the toggle, not a small chevron target - a
          44px-plus tap area is the difference between a list that feels
          native and one that feels like a website. */}
      <button
        type="button"
        className="m-trade-card-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="m-trade-card-main">
          <span className="m-trade-card-toprow">
            <span className={`m-dir m-dir--${trade.direction}`}>{trade.direction === 'long' ? 'LONG' : 'SHORT'}</span>
            {instrumentSymbol ? <span className="m-trade-inst">{instrumentSymbol}</span> : null}
            {/* showStrategy=false is how the per-strategy page suppresses
                this, mirroring the desktop table's showStrategyColumn.
                Passing a name-resolver that returns null did NOT work:
                the fallback below turned every card on that page into
                "Unassigned", labelling a strategy's own trades as having
                no strategy. */}
            {showStrategy ? <span className="m-trade-strategy">{strategyName || 'Unassigned'}</span> : null}
          </span>
          <span className="m-trade-card-date">{fmtDate(trade.trade_date)}{trade.trade_time ? ` · ${trade.trade_time.slice(0, 5)}` : ''}</span>
        </span>

        {/* Dollars lead, R is the sub-value - the repo's own convention
            (CLAUDE.md, UI conventions). When no dollar figure exists, R
            moves up into the lead slot rather than leaving a dash. */}
        <span className="m-trade-card-figures">
          {pnl
            ? <><span className={`m-trade-pnl ${trade.pnl >= 0 ? 'is-pos' : 'is-neg'}`}>{pnl}</span>
                {r ? <span className="m-trade-r">{r}</span> : null}</>
            : /* No dollar figure. R moves up into the lead slot - but a
                 row with neither gets a plain em dash and NO colour: the
                 first version tested `trade.r_multiple >= 0`, which is
                 true for null, so an open trade rendered a confident
                 green dash. */
              <span className={`m-trade-pnl ${r ? (trade.r_multiple >= 0 ? 'is-pos' : 'is-neg') : ''}`}>{r || '—'}</span>}
        </span>
        <ChevronDown className="m-trade-chevron" size={16} aria-hidden="true" />
      </button>

      {open ? (
        <div className="m-trade-card-detail">
          <dl className="m-detail-grid">
            <div><dt>Entry</dt><dd>{fmtNum(trade.entry)}</dd></div>
            <div><dt>Exit</dt><dd>{multiExit ? `${exitLegs.length} legs` : fmtNum(trade.exit_price)}</dd></div>
            <div><dt>Stop</dt><dd>{fmtNum(trade.stop)}</dd></div>
            <div><dt>Target</dt><dd>{fmtNum(trade.target)}</dd></div>
            <div><dt>Contracts</dt><dd>{totalContracts || '—'}</dd></div>
            <div><dt>Result</dt><dd className={`m-result m-result--${result}`}>{result}</dd></div>
          </dl>

          {multiExit ? (
            <ul className="m-exit-legs">
              {exitLegs.map((leg, i) => (
                <li key={i}>
                  <span>Exit {i + 1}</span>
                  <span>{fmtNum(leg.exit_price)} · {leg.contracts == null ? '—' : `${leg.contracts}x`}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {trade.tags?.length ? (
            <div className="m-trade-tags">
              {trade.tags.map((tag) => <span className="m-tag" key={tag}>{tag}</span>)}
            </div>
          ) : null}

          {trade.notes ? <p className="m-trade-notes">{trade.notes}</p> : null}

          {editHref ? (
            <Link className="m-trade-edit" href={editHref}>
              <Pencil size={14} aria-hidden="true" /> Edit trade
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export default function MobileTradeList({
  trades = [],
  strategyNameById,
  symbol,
  instrumentSymbolFor = null,
  emptyState = null,
  onOpenFilters = null,
  activeFilterCount = 0,
  totalCount = null,
  showStrategy = true,
}) {
  const count = totalCount === null ? trades.length : totalCount
  const filtered = activeFilterCount > 0

  // "No trades at all" and "no trades MATCHING" are different facts, and
  // only the first one is the empty state.
  //
  // This returned the empty state for both, before the toolbar was
  // rendered - so filtering to zero results removed the Filter button,
  // which is the only way back to the sheet. The trader was left on a
  // screen reading "No trades yet - log your first one" for an instrument
  // full of trades, with no control to undo it and no way out but a
  // reload. The desktop table has always distinguished the two
  // (TradeLogTable only shows emptyState when nothing is filtered);
  // this now does too, and keeps the toolbar up either way.
  if (!trades.length && !filtered) {
    return emptyState || <p className="m-empty">No trades yet.</p>
  }

  return (
    <>
      <div className="m-list-toolbar">
        <span className="m-list-count">{count} {count === 1 ? 'trade' : 'trades'}</span>
        {onOpenFilters ? (
          <button type="button" className="m-filter-btn" onClick={onOpenFilters}>
            <SlidersHorizontal size={15} aria-hidden="true" />
            Filter
            {activeFilterCount > 0 ? <span className="m-filter-count">{activeFilterCount}</span> : null}
          </button>
        ) : null}
      </div>

      {trades.length ? (
        <ul className="m-trade-list">
          {trades.map((t) => (
            <TradeCard
              key={t.id}
              trade={t}
              symbol={symbol}
              showStrategy={showStrategy}
              strategyName={t.strategy_id ? strategyNameById?.(t.strategy_id) : null}
              instrumentSymbol={instrumentSymbolFor ? instrumentSymbolFor(t) : null}
            />
          ))}
        </ul>
      ) : (
        <p className="m-empty">No trades match these filters.</p>
      )}
    </>
  )
}
