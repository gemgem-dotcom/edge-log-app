'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, SlidersHorizontal, Pencil, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import {
  hasResult, calcRiskReward, calcRMultiple,
  tradeDurationMinutes, formatDuration, formatTime12h,
} from '@/lib/tradeMath'
import { formatExcursionPoints, excursionCell, MFE_HINT, MAE_HINT } from '@/lib/tradeExcursions'
import { getThumbnailUrls, getScreenshotUrls } from '@/lib/screenshots'
import { useConfirm } from '@/lib/useConfirm'
import { invalidateTags } from '@/lib/tagsCache'
import ScreenshotLightbox from '@/components/ScreenshotLightbox'
import ScreenshotThumb from '@/components/ScreenshotThumb'
import FieldTooltip from '@/components/FieldTooltip'

// The trade log, as a phone actually wants it.
//
// This replaces TradeLogTable below the mobile breakpoint, and it exists
// because the table did not merely look cramped there - it HID THE DATA.
// At 390px the eight columns collapsed to three (Date, Day, Strategy),
// with the strategy name itself truncated mid-word, and direction, entry,
// exit, R-multiple and P&L were simply not reachable.
//
// The expanded row now carries EVERY field the desktop's expanded row
// carries. It did not before: the first version had six, against the
// desktop's nine plus discipline tags plus screenshots, so MFE, MAE, time
// in drawdown, realised R, the entry time, the stop/target distances, the
// per-leg R and every screenshot were invisible on a phone. Replacing a
// table that hid data with a card that hid a different subset of the same
// data is not a fix, which is why the parity here is checked by a test
// (lib/mobileTradeList.test.js) rather than by eye.
//
// Every class is prefixed `m-` and every rule for them lives inside the
// mobile media query, so none of this can reach the desktop table.

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

// Three letters, not the desktop DAY column's full name. The desktop puts
// the day in its own column, where every cell is the same width; here it
// shares a sub-line with the time, so WEDNESDAY and FRI made the column's
// content a different shape on every row.
const SHORT_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
function dayNameOf(dateStr) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '' : SHORT_DAYS[d.getDay()]
}

// Planned R:R, through the one shared implementation - never recomputed
// here. CLAUDE.md is explicit that every R figure routes through
// lib/tradeMath so a displayed figure can't drift from the stored one.
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
// breakeven to r_multiple = 0 (lib/tradeQuery.js).
function resultOf(trade) {
  if (!hasResult(trade)) return 'open'
  if (trade.r_multiple > 0) return 'win'
  if (trade.r_multiple < 0) return 'loss'
  return 'breakeven'
}

// The Edit/Delete links need an instrument in their path, and the
// all-instruments log has no page-level symbol - each row belongs to a
// different one. So the row's own symbol wins, the page's is the
// fallback, and when there is neither the link is not rendered at all
// rather than pointing at /app/null/log/<id>/edit. A dead link is worse
// than a missing one, and that exact mistake shipped once already in this
// work (the Strategies tab, which 404'd).
function editHrefFor(trade, symbol, instrumentSymbol) {
  const s = instrumentSymbol || symbol
  return s ? `/app/${s}/log/${trade.id}/edit` : null
}

function shotsFor(trade) {
  return trade.screenshot_urls?.length ? trade.screenshot_urls : (trade.screenshot_url ? [trade.screenshot_url] : [])
}

function TradeCard({
  trade, strategyName, symbol, instrumentSymbol, showStrategy,
  timezoneOffset, onDelete, onOpenShot, thumbUrls, onExpand,
}) {
  const [open, setOpen] = useState(false)
  const result = resultOf(trade)
  const editHref = editHrefFor(trade, symbol, instrumentSymbol)
  const pnl = fmtPnl(trade.pnl)
  const r = fmtR(trade.r_multiple)
  const closed = hasResult(trade)

  const exitLegs = [
    { exit_time: trade.exit_time, exit_price: trade.exit_price, contracts: trade.contracts },
    ...(trade.additional_exits || []),
  ]
  const multiExit = exitLegs.length > 1
  const lastLeg = exitLegs[exitLegs.length - 1]
  const totalContracts = exitLegs.reduce((sum, leg) => sum + (leg.contracts == null ? 0 : Number(leg.contracts)), 0)
  const shots = shotsFor(trade)

  // The desktop table's own pill classes, not lookalikes. r-pill/r-pos/
  // r-neg/r-zero are defined once near the top of globals.css and are
  // what the trade log has always used; reusing them is what makes this
  // read as the same product rather than an imitation of it, and means a
  // change to that pill lands on both surfaces at once.
  const rClass = result === 'win' ? 'r-pos' : result === 'loss' ? 'r-neg' : 'r-zero'

  function toggle() {
    const expanding = !open
    setOpen(expanding)
    if (expanding) onExpand(trade)
  }

  return (
    <li className="m-row">
      <button type="button" className="m-row-head" onClick={toggle} aria-expanded={open}>
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
          {/* Every <label> in the desktop's own expanded block, in the
              same order. A source-scan test asserts that list stays in
              step with TradeLogTable's. */}
          <dl className="m-detail-grid">
            <div>
              <dt>Entry</dt>
              <dd>
                {fmtNum(trade.entry)}
                <span className="m-detail-sub">
                  {formatTime12h(trade.trade_time)}
                  {trade.trade_time_unverified ? <span className="time-unverified-badge">Unverified</span> : null}
                </span>
              </dd>
            </div>
            <div>
              <dt>Stop loss</dt>
              <dd>
                {fmtNum(trade.stop)}
                {trade.stop_distance != null ? <span className="m-detail-sub">{fmtNum(trade.stop_distance)} pts</span> : null}
              </dd>
            </div>
            <div>
              <dt>Take profit</dt>
              <dd>
                {trade.target == null ? '—' : fmtNum(trade.target)}
                {trade.target_distance != null ? <span className="m-detail-sub">{fmtNum(trade.target_distance)} pts</span> : null}
              </dd>
            </div>
            <div>
              <dt>{multiExit ? 'Exit legs' : 'Exit price'}</dt>
              <dd>
                {multiExit ? (
                  <ol className="m-exit-list">
                    {exitLegs.map((leg, i) => {
                      // Per-leg R through calcRMultiple, the same shared
                      // implementation the desktop uses - not a second
                      // formula.
                      const legR = calcRMultiple(trade.direction, trade.entry, trade.stop, parseFloat(leg.exit_price))
                      return (
                        <li key={i}>
                          {fmtNum(leg.exit_price)} ({leg.contracts == null ? '—' : leg.contracts}x)
                          {legR !== null ? (
                            <span className={legR > 0 ? 'pnl-pos' : legR < 0 ? 'pnl-neg' : ''}> · {(legR >= 0 ? '+' : '') + legR.toFixed(2)}R</span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ol>
                ) : fmtNum(trade.exit_price)}
                <span className="m-detail-sub">
                  {formatDuration(tradeDurationMinutes({ trade_time: trade.trade_time, exit_time: lastLeg.exit_time }))} · {totalContracts} contracts
                </span>
              </dd>
            </div>
            <div>
              <dt>Planned R:R</dt>
              <dd>{fmtRR(trade)}</dd>
            </div>
            <div>
              <dt>Realised R</dt>
              <dd className={!closed ? '' : trade.r_multiple > 0 ? 'pnl-pos' : trade.r_multiple < 0 ? 'pnl-neg' : ''}>
                {closed ? `${trade.r_multiple >= 0 ? '+' : ''}${trade.r_multiple.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}R` : '—'}
              </dd>
            </div>
            <div>
              <dt>MFE <FieldTooltip text={MFE_HINT} /></dt>
              <dd>{excursionCell(trade, timezoneOffset, formatExcursionPoints(trade.mfe_points))}</dd>
            </div>
            <div>
              <dt>MAE <FieldTooltip text={MAE_HINT} /></dt>
              <dd>{excursionCell(trade, timezoneOffset, formatExcursionPoints(trade.mae_points))}</dd>
            </div>
            <div>
              <dt>Time in drawdown</dt>
              {/* drawdown_seconds is nullable even on a 'complete' trade,
                  and null / 60 is 0 - which formatDuration renders as a
                  confident "0m", i.e. "never underwater", for a trade
                  whose drawdown simply was not recorded. Same guard the
                  desktop cell carries. */}
              <dd>{excursionCell(trade, timezoneOffset, trade.market_data_status === 'complete' && trade.drawdown_seconds !== null && trade.drawdown_seconds !== undefined ? formatDuration(Math.round(trade.drawdown_seconds / 60)) : null)}</dd>
            </div>
          </dl>

          {trade.discipline_tags?.length ? (
            <div className="m-detail-block">
              <span className="m-detail-label">Discipline</span>
              <div className="m-trade-tags">
                {trade.discipline_tags.map((tag) => <span className="trade-tag discipline-tag" key={tag}>{tag}</span>)}
              </div>
            </div>
          ) : null}

          {trade.tags?.length ? (
            <div className="m-detail-block">
              <span className="m-detail-label">Tags</span>
              <div className="m-trade-tags">
                {trade.tags.map((tag) => <span className="trade-tag" key={tag}>{tag}</span>)}
              </div>
            </div>
          ) : null}

          {/* `reasoning`, not `notes`. There is no notes column - the
              schema calls it reasoning and the desktop table reads
              t.reasoning - so the first version of this line silently
              rendered nothing for every trade that had one. */}
          {trade.reasoning ? (
            <div className="m-detail-block">
              <span className="m-detail-label">Notes</span>
              <p className="m-trade-notes">{trade.reasoning}</p>
            </div>
          ) : null}

          {shots.length ? (
            <div className="m-shot-grid">
              {/* The same tile the desktop table renders, from the same
                  component - see ScreenshotThumb on why it is shared. */}
              {shots.map((path, i) => (
                <ScreenshotThumb
                  key={path}
                  url={thumbUrls[i]}
                  index={i}
                  size={64}
                  className="m-shot"
                  onOpen={() => onOpenShot(trade, i)}
                />
              ))}
            </div>
          ) : null}

          <div className="m-row-actions">
            {editHref ? (
              <Link className="m-trade-edit" href={editHref}>
                <Pencil size={13} aria-hidden="true" /> Edit trade
              </Link>
            ) : null}
            {/* The desktop row has Edit AND Delete in its actions column.
                Mobile had only Edit, so there was no way to delete a
                trade from a phone at all. */}
            <button type="button" className="m-trade-delete" onClick={() => onDelete(trade)}>
              <Trash2 size={13} aria-hidden="true" /> Delete
            </button>
          </div>
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
  onTradeDeleted = null,
}) {
  const count = totalCount === null ? trades.length : totalCount
  const filtered = activeFilterCount > 0

  // Only needed for a still-'pending' trade's "Available in ~Xh" message
  // (lib/tradeExcursions.js's excursionStatusMessage) - same account
  // offset trade save/edit already convert wall-clock times with.
  const [timezoneOffset, setTimezoneOffset] = useState(null)
  // Resolved thumbnail URLs, keyed by trade id, fetched lazily as each
  // row expands. The bucket is private, so a stored screenshot_urls entry
  // is a storage path and never a usable URL. Full-size URLs are resolved
  // only when a specific shot is actually opened - resolving them for
  // every expanded row would defeat the point of thumbnails existing.
  const [thumbs, setThumbs] = useState({})
  const [full, setFull] = useState({})
  const [preview, setPreview] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  const { confirm, modal: confirmModal } = useConfirm()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setTimezoneOffset(parseFloat(user?.user_metadata?.timezone))
    })
  }, [])

  function handleExpand(trade) {
    if (thumbs[trade.id]) return
    const shots = shotsFor(trade)
    if (shots.length === 0) return
    getThumbnailUrls(shots).then((urls) => setThumbs((prev) => ({ ...prev, [trade.id]: urls })))
  }

  // Opens the lightbox immediately on the already-loaded thumbnail while
  // the full-size URL resolves behind it, then swaps - same treatment the
  // desktop table gives it. The tradeId check stops a resolve from a
  // since-closed trade overwriting whatever is open now.
  function handleOpenShot(trade, index) {
    const cached = full[trade.id]
    if (cached) { setPreview({ shots: cached, index, tradeId: trade.id }); return }
    setPreview({ shots: thumbs[trade.id] || [], index, tradeId: trade.id })
    getScreenshotUrls(shotsFor(trade)).then((urls) => {
      setFull((prev) => ({ ...prev, [trade.id]: urls }))
      setPreview((prev) => (prev?.tradeId === trade.id ? { ...prev, shots: urls } : prev))
    })
  }

  async function handleDelete(trade) {
    const sure = await confirm({ title: 'Delete Trade', message: 'This action cannot be undone.', confirmLabel: 'Delete trade', danger: true })
    if (!sure) return
    setDeleteError(null)
    const { error } = await supabase.from('trades').delete().eq('id', trade.id)
    if (error) { setDeleteError("Couldn't delete that trade. Please try again."); return }
    invalidateTags()
    // The caller owns the rows (every mobile call site fetches its own
    // page), so it refetches rather than this trimming a local copy that
    // the page's own stats were never computed from.
    onTradeDeleted?.(trade.id)
  }

  // "No trades at all" and "no trades MATCHING" are different facts, and
  // only the first one is the empty state.
  //
  // This returned the empty state for both, before the toolbar was
  // rendered - so filtering to zero results removed the Filter button,
  // which is the only way back to the sheet. The trader was left on a
  // screen reading "No trades yet - log your first one" for an instrument
  // full of trades, with no control to undo it and no way out but a
  // reload. The desktop table has always distinguished the two; this now
  // does too, and keeps the toolbar up either way.
  if (!trades.length && !filtered) {
    return emptyState || <p className="m-empty">No trades yet.</p>
  }

  return (
    <>
      {deleteError ? <p className="m-empty pnl-neg">{deleteError}</p> : null}
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
              timezoneOffset={timezoneOffset}
              thumbUrls={thumbs[t.id] || []}
              onExpand={handleExpand}
              onOpenShot={handleOpenShot}
              onDelete={handleDelete}
            />
          ))}
        </ul>
        </>
      ) : (
        <p className="m-empty">No trades match these filters.</p>
      )}

      {preview ? (
        <ScreenshotLightbox
          shots={preview.shots}
          index={preview.index}
          onIndexChange={(i) => setPreview((prev) => ({ ...prev, index: i }))}
          onClose={() => setPreview(null)}
        />
      ) : null}
      {confirmModal}
    </>
  )
}
