'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, SlidersHorizontal, Pencil } from 'lucide-react'
import { hasResult, calcRiskReward } from '@/lib/tradeMath'

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

// Full weekday name, matching the desktop table's DAY column.
const FULL_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
function dayNameOf(dateStr) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '' : FULL_DAYS[d.getDay()]
}

// Planned R:R, through the one shared implementation - never recomputed
// here. CLAUDE.md is explicit that every R figure routes through
// lib/tradeMath so a displayed number cannot drift from the stored one.
function fmtRR(trade) {
  const rr = calcRiskReward(trade.target_distance, trade.stop_distance)
  return rr === null || rr === undefined ? '—' : `${Number(rr).toFixed(2)}`
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

  // The desktop table's own pill classes, not lookalikes. r-pill/r-pos/
  // r-neg/r-zero are defined once near the top of globals.css and are
  // what the trade log has always used; reusing them is what makes this
  // read as the same product rather than an imitation of it, and means a
  // change to that pill lands on both surfaces at once.
  const rClass = result === 'win' ? 'r-pos' : result === 'loss' ? 'r-neg' : 'r-zero'

  return (
    <li className="m-row">
      <button
        type="button"
        className="m-row-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {/* Column 1 - what the desktop puts in DATE and DAY. */}
        <span className="m-col">
          <span className="m-date">{trade.trade_date}</span>
          <span className="m-sub">{dayNameOf(trade.trade_date)}{trade.trade_time ? ` · ${trade.trade_time.slice(0, 5)}` : ''}</span>
        </span>

        {/* Column 2 - STRATEGY over DIRECTION, the desktop's own colours. */}
        <span className="m-col">
          {showStrategy ? <span className="m-strategy-cell">{strategyName || 'Unassigned'}</span> : null}
          <span className="m-sub">
            <span className={trade.direction === 'long' ? 'm-long' : 'm-short'}>
              {trade.direction === 'long' ? 'LONG' : 'SHORT'}
            </span>
            {instrumentSymbol ? <span className="m-inst"> · {instrumentSymbol}</span> : null}
          </span>
        </span>

        {/* Column 3 - RESULT over P&L, right aligned. Dollars lead and R
            is the sub-value everywhere both are shown (CLAUDE.md), but
            the desktop's RESULT column is the pill, so the pill keeps the
            upper slot and the dollar figure sits under it in the same
            colour the desktop uses. */}
        <span className="m-col m-col-figs">
          {result === 'open'
            ? <span className="r-pill r-zero">Open</span>
            : <span className={`r-pill ${rClass}`}>{r}</span>}
          <span className={`m-sub ${trade.pnl == null ? '' : trade.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
            {pnl || '—'}
          </span>
        </span>

        <ChevronDown className="m-row-chevron" size={15} aria-hidden="true" />
      </button>

      {open ? (
        <div className="m-row-detail">
          <dl className="m-detail-grid">
            <div><dt>Entry</dt><dd>{fmtNum(trade.entry)}</dd></div>
            <div><dt>Exit</dt><dd>{multiExit ? `${exitLegs.length} legs` : fmtNum(trade.exit_price)}</dd></div>
            <div><dt>Stop</dt><dd>{fmtNum(trade.stop)}</dd></div>
            <div><dt>Target</dt><dd>{fmtNum(trade.target)}</dd></div>
            <div><dt>Contracts</dt><dd>{totalContracts || '—'}</dd></div>
            <div><dt>R:R</dt><dd>{fmtRR(trade)}</dd></div>
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

          {/* `reasoning`, not `notes`. There is no notes column - the
              schema calls it reasoning and the desktop table reads
              t.reasoning - so the first version of this line silently
              rendered nothing for every trade that had one. */}
          {trade.reasoning ? <p className="m-trade-notes">{trade.reasoning}</p> : null}

          {editHref ? (
            <Link className="m-trade-edit" href={editHref}>
              <Pencil size={13} aria-hidden="true" /> Edit trade
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
      {/* Filter left, count right - the order the desktop table uses. */}
      <div className="m-list-toolbar">
        {onOpenFilters ? (
          <button type="button" className="m-filter-btn" onClick={onOpenFilters}>
            <SlidersHorizontal size={15} aria-hidden="true" />
            Filter
            {activeFilterCount > 0 ? <span className="m-filter-count">{activeFilterCount}</span> : null}
          </button>
        ) : <span />}
        <span className="m-list-count">{count} {count === 1 ? 'trade' : 'trades'}</span>
      </div>

      {trades.length ? (
        <>
        {/* A real column header, the same three labels the desktop table
            leads with. Without it the rows are a list of values with no
            statement of what they are - which is most of what made the
            first version read as a generic feed rather than as this
            app's trade log. */}
        <div className="m-rows-head" aria-hidden="true">
          <span>Date</span>
          <span>{showStrategy ? 'Strategy' : 'Direction'}</span>
          <span>Result</span>
          <span />
        </div>
        <ul className="m-rows">
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
        </>
      ) : (
        <p className="m-empty">No trades match these filters.</p>
      )}
    </>
  )
}
