'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import Link from 'next/link'
import { Pencil, Trash2, X, Filter, ChevronLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hasResult, calcRiskReward, calcRMultiple, tradeDurationMinutes, formatDuration, formatTime12h } from '../lib/tradeMath'
import { formatExcursionPoints, excursionStatusMessage, MFE_HINT, MAE_HINT } from '../lib/tradeExcursions'
import { reverseTrade } from '../lib/edgeBeliefs'
import { getScreenshotUrls, getThumbnailUrls } from '../lib/screenshots'
import { useConfirm } from '../lib/useConfirm'
import { useClickOutside } from '../lib/useClickOutside'
import ColumnFilter from './ColumnFilter'
import ErrorBanner from './ErrorBanner'
import ScreenshotLightbox from './ScreenshotLightbox'
import FieldTooltip from './FieldTooltip'

const DIRECTION_LABELS = { long: 'Long', short: 'Short' }
const RESULT_LABELS = { win: 'Win', loss: 'Loss', breakeven: 'Breakeven', open: 'Open' }
const UNCLASSIFIED = 'unclassified'

// Checkbox-style filter button + dropdown above the table, same interaction
// pattern as EconomicCalendarCard's impact filter (independent checkboxes,
// applied immediately, closes on outside click/scroll) - not shared code
// since the two live in different feature areas, but deliberately the same
// shape so a "checkbox filter" looks and behaves the same everywhere it
// shows up in the app.
function TagFilterMenu({ options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    // capture:true is what lets this see the dropdown's own scrollbar
    // scrolling (a native 'scroll' event doesn't bubble, so a plain
    // bubble-phase listener would never see it) - but that means it has to
    // explicitly ignore scrolls that originate inside the dropdown itself
    // (.col-filter-menu scrolls internally once there are enough tags to
    // exceed its max-height), or scrolling the list would close the very
    // list being scrolled. Same fix as TradeForm.js's tag-suggestions
    // dropdown, which hit the identical bug.
    const dismissOnScroll = (e) => {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return
      dismiss()
    }
    window.addEventListener('scroll', dismissOnScroll, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  function toggle(value) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  return (
    <div className="trade-tag-filter" ref={wrapRef}>
      <button type="button" className="calendar-strategy-filter trade-tag-filter-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Filter size={14} />
        Filter
      </button>
      {open && (
        <div className="col-filter-menu trade-tag-filter-menu">
          {options.map((o) => (
            <label key={o.value} className="col-filter-option">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// Full week: futures sessions open Sunday evening, and a stray Saturday date
// should still render a day name rather than blank.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function fmtPnl(value) {
  if (value === null || value === undefined) return '—'
  const sign = value >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Plain thousands-grouped number, no sign/currency - for raw prices and
// point distances, which are now stored to two decimal places (see
// toDecimalString in lib/tradeForm.js) and always display at that same
// precision, e.g. "32" -> "32.00".
function fmtNum(value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function dayOf(trade) {
  return DAY_NAMES[new Date(trade.trade_date + 'T00:00:00').getDay()]
}

function resultOf(trade) {
  if (!hasResult(trade)) return 'open'
  if (trade.r_multiple > 0) return 'win'
  if (trade.r_multiple < 0) return 'loss'
  return 'breakeven'
}

// Same fallback shape as the trade detail page's own excursionCell -
// realValue is whatever the caller already computed for 'complete', null
// otherwise; a 'complete' trade whose fill couldn't be verified
// (excursion_fallback) is treated as not having a real value either (see
// lib/tradeExcursions.js's excursionStatusMessage). A null
// market_data_status (never attempted, or not an NQ-family trade) falls
// through to the same plain "—" every other not-yet-applicable field in
// this row already uses.
function excursionCell(trade, timezoneOffset, realValue) {
  if (trade.market_data_status === 'complete' && !trade.excursion_fallback && realValue !== null && realValue !== undefined) return realValue
  return excursionStatusMessage(trade, timezoneOffset) || '—'
}

export default function TradeLogTable({
  trades,
  strategies = [],
  strategyNameById,
  showStrategyColumn = false,
  // The dashboard's calendar-day table opts out of these so it keeps the
  // exact column set it had before.
  showDayColumn = true,
  showPnlColumn = true,
  showFilters = false,
  symbol,
  // The all-instruments trades page has no single symbol - it shows an
  // Instrument column instead and resolves each row's own symbol/color
  // through these two functions rather than the fixed `symbol` prop above.
  showInstrumentColumn = false,
  instrumentSymbolFor = null,
  instrumentColorFor = null,
  // The Overview page's Recent trades list has no Day column (so the date
  // needs to carry the time itself) - every other caller leaves this off
  // and gets the plain date, unchanged.
  showTimeInDate = false,
  // Overrides the default "no trades at all" message below - callers pass
  // a tailored EmptyState (with a page-appropriate call to action) instead
  // of this component hardcoding one copy for every context it's reused in.
  emptyState = null,
  // Opt-in - callers that don't pass this keep showing every matching
  // trade at once, unchanged. Only the per-strategy page's trade log asks
  // for this today. Rows arrive already ordered by the caller's own query
  // (reverse chronological everywhere this table is used), so paging is a
  // plain slice with no re-sort here.
  pageSize = null,
}) {
  const [rows, setRows] = useState(trades)
  const [expandedId, setExpandedId] = useState(null)
  // Holds both the clicked row's screenshot array and the index within it -
  // unlike the single trade detail page, every row here has its own shots
  // array computed inline in the map below, so the modal needs a reference
  // to the right one, not just a bare URL.
  const [preview, setPreview] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  // Resolved thumbnail URLs, keyed by trade id - fetched lazily as each row
  // expands (not eagerly for every trade in the table) since the bucket is
  // private and a stored screenshot_urls entry is a storage path, never a
  // directly usable URL (see lib/screenshots.js's getThumbnailUrls). The
  // grid only ever shows a 70x70 tile, so it never needs the full-size
  // image - resolvedFull below holds that instead, fetched only once a
  // specific screenshot is actually opened in the lightbox, since eagerly
  // resolving full-size URLs for every expanded row would defeat the point
  // of thumbnails existing at all.
  const [resolvedThumbnails, setResolvedThumbnails] = useState({})
  const [resolvedFull, setResolvedFull] = useState({})
  const { confirm, modal: confirmModal } = useConfirm()

  // Filters open from a chevron on each column heading. Day and Strategy
  // take any combination of values; an empty array means unfiltered.
  const [filterDays, setFilterDays] = useState([])
  const [filterStrategies, setFilterStrategies] = useState([])
  const [filterDirection, setFilterDirection] = useState('all')
  const [filterResult, setFilterResult] = useState('all')
  // Tags aren't a column (they only show in the expand row), so this lives
  // in the toolbar above the table instead of a column-header chevron. A
  // trade matches if it has any one of the selected tags.
  const [filterTags, setFilterTags] = useState([])
  // Only needed for a still-'pending' trade's "Available in ~Xh" message
  // (lib/tradeExcursions.js's excursionStatusMessage) - same account
  // offset trade save/edit already convert wall-clock times with.
  const [timezoneOffset, setTimezoneOffset] = useState(null)
  const [page, setPage] = useState(0)

  useEffect(() => {
    setRows(trades)
    setPage(0)
  }, [trades])

  // A filter change can shrink the visible set out from under whatever
  // page was showing (e.g. viewing page 3 of 42 trades, then filtering
  // down to 5) - land back on page 1 rather than an empty or stale page.
  useEffect(() => {
    setPage(0)
  }, [filterDays, filterStrategies, filterDirection, filterResult, filterTags])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setTimezoneOffset(parseFloat(user?.user_metadata?.timezone))
    })
  }, [])

  // Support deep links like /log?strategy=<id> from the dashboard table.
  useEffect(() => {
    if (!showFilters || !showStrategyColumn) return
    const initial = new URLSearchParams(window.location.search).get('strategy')
    if (initial) setFilterStrategies([initial])
  }, [showFilters, showStrategyColumn])

  function shotsFor(trade) {
    return trade.screenshot_urls?.length ? trade.screenshot_urls : (trade.screenshot_url ? [trade.screenshot_url] : [])
  }

  function toggleExpand(trade) {
    const expanding = expandedId !== trade.id
    setExpandedId((prev) => (prev === trade.id ? null : trade.id))
    if (expanding && !resolvedThumbnails[trade.id]) {
      const shots = shotsFor(trade)
      if (shots.length === 0) return
      getThumbnailUrls(shots).then((urls) => {
        setResolvedThumbnails((prev) => ({ ...prev, [trade.id]: urls }))
      })
    }
  }

  // Opens the lightbox immediately using whatever thumbnail is already on
  // screen (instant, since it's already loaded) while the full-size URL
  // resolves in the background, then swaps it in once ready - better than
  // either a blank modal for the brief gap or eagerly resolving full-size
  // URLs for every row that merely expands. The tradeId check guards
  // against a resolve from a since-closed trade overwriting whatever the
  // trader has since opened instead.
  function openPreview(trade, index) {
    const cached = resolvedFull[trade.id]
    if (cached) {
      setPreview({ shots: cached, index, tradeId: trade.id })
      return
    }
    setPreview({ shots: resolvedThumbnails[trade.id] || [], index, tradeId: trade.id })
    getScreenshotUrls(shotsFor(trade)).then((urls) => {
      setResolvedFull((prev) => ({ ...prev, [trade.id]: urls }))
      setPreview((prev) => (prev?.tradeId === trade.id ? { ...prev, shots: urls } : prev))
    })
  }

  async function handleDelete(e, trade) {
    e.stopPropagation()
    const sure = await confirm({ title: 'Delete Trade', message: 'This action cannot be undone.', confirmLabel: 'Delete trade', danger: true })
    if (!sure) return
    setDeleteError(null)
    const { error } = await supabase.from('trades').delete().eq('id', trade.id)
    if (!error) {
      try {
        await reverseTrade(supabase, trade)
      } catch (beliefError) {
        console.error('reverseTrade failed:', beliefError)
      }
      setRows((prev) => prev.filter((t) => t.id !== trade.id))
      if (expandedId === trade.id) setExpandedId(null)
    } else {
      setDeleteError(`Couldn't delete that trade — ${error.message}`)
    }
  }

  const strategyKey = (t) => t.strategy_id || UNCLASSIFIED

  const visible = showFilters
    ? rows.filter((t) => {
        if (filterDays.length > 0 && !filterDays.includes(dayOf(t))) return false
        if (filterStrategies.length > 0 && !filterStrategies.includes(strategyKey(t))) return false
        if (filterDirection !== 'all' && t.direction !== filterDirection) return false
        if (filterResult !== 'all' && resultOf(t) !== filterResult) return false
        if (filterTags.length > 0 && !(t.tags || []).some((tag) => filterTags.includes(tag.toLowerCase()))) return false
        return true
      })
    : rows

  if (rows.length === 0) {
    return emptyState || <div className="empty">No trades match this view yet.</div>
  }

  // Clamped against the current `visible` length (not just reset via the
  // effects above) so a mid-page delete - which shrinks `rows` without
  // going through those effects - can't strand the view on a now-empty
  // trailing page.
  const totalPages = pageSize ? Math.max(1, Math.ceil(visible.length / pageSize)) : 1
  const safePage = Math.min(page, totalPages - 1)
  const pageStart = pageSize ? safePage * pageSize : 0
  const paged = pageSize ? visible.slice(pageStart, pageStart + pageSize) : visible

  // Each filter offers its full set of values rather than only the ones the
  // current trades happen to use, so the options stay put as trades come and
  // go. Picking a value with no matches simply yields an empty table.
  const present = (fn) => new Set(rows.map(fn))
  const dayOptions = DAY_NAMES.map((d) => ({ value: d, label: d }))
  // Every strategy the user has created, plus any a trade still points at
  // (an archived one, say) and Unassigned when some trade has no strategy.
  const strategyKeys = [
    ...strategies.map((s) => s.id),
    ...[...present(strategyKey)].filter((key) => !strategies.some((s) => s.id === key)),
  ]
  const strategyOptions = strategyKeys
    .map((key) => ({
      value: key,
      label: key === UNCLASSIFIED ? 'Unassigned' : (strategyNameById?.(key) || '—'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const directionOptions = [
    { value: 'all', label: 'All' },
    ...['long', 'short'].map((d) => ({ value: d, label: DIRECTION_LABELS[d] })),
  ]
  const resultOptions = [
    { value: 'all', label: 'All' },
    ...['breakeven', 'loss', 'win'].map((r) => ({ value: r, label: RESULT_LABELS[r] })),
  ]
  // Case-insensitive, same dedup as the tag-suggestions dropdown on the
  // trade form (lib/tradeForm.js) - "FOMC" and "fomc" are one option, kept
  // under whichever casing was seen first.
  const tagOptionMap = new Map()
  for (const t of rows) {
    for (const tag of t.tags || []) {
      const key = tag.toLowerCase()
      if (!tagOptionMap.has(key)) tagOptionMap.set(key, tag)
    }
  }
  const tagOptions = [...tagOptionMap.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))

  // One chip per selected value, whichever column it came from.
  const chips = [
    ...filterDays.map((d) => ({
      key: `day-${d}`, label: `Day: ${d}`,
      clear: () => setFilterDays((prev) => prev.filter((v) => v !== d)),
    })),
    ...filterStrategies.map((s) => ({
      key: `strategy-${s}`,
      label: `Strategy: ${s === UNCLASSIFIED ? 'Unassigned' : (strategyNameById?.(s) || '—')}`,
      clear: () => setFilterStrategies((prev) => prev.filter((v) => v !== s)),
    })),
    ...(filterDirection !== 'all' ? [{
      key: 'direction', label: `Direction: ${DIRECTION_LABELS[filterDirection] || filterDirection}`,
      clear: () => setFilterDirection('all'),
    }] : []),
    ...(filterResult !== 'all' ? [{
      key: 'result', label: `Result: ${RESULT_LABELS[filterResult] || filterResult}`,
      clear: () => setFilterResult('all'),
    }] : []),
    ...filterTags.map((v) => ({
      key: `tag-${v}`, label: tagOptionMap.get(v) || v,
      clear: () => setFilterTags((prev) => prev.filter((val) => val !== v)),
    })),
  ]

  function clearAllFilters() {
    setFilterDays([])
    setFilterStrategies([])
    setFilterDirection('all')
    setFilterResult('all')
    setFilterTags([])
  }

  const colCount = 4
    + (showDayColumn ? 1 : 0)
    + (showPnlColumn ? 1 : 0)
    + (showStrategyColumn ? 1 : 0)
    + (showInstrumentColumn ? 1 : 0)

  return (
    <div id="tableWrap">
      <ErrorBanner message={deleteError} />
      {/* Only rendered once there's at least one tag to filter by - an
          always-empty dropdown would just be clutter for traders who
          haven't tagged anything yet. */}
      {showFilters && tagOptions.length > 0 && (
        <div className="trade-log-toolbar">
          <TagFilterMenu options={tagOptions} selected={filterTags} onChange={setFilterTags} />
        </div>
      )}
      {showFilters && chips.length > 0 && (
        <div className="active-filters">
          {chips.map((chip) => (
            <span key={chip.key} className="filter-chip">
              {chip.label}
              <button type="button" onClick={chip.clear} aria-label={`Remove filter ${chip.label}`}>
                <X size={12} />
              </button>
            </span>
          ))}
          <span className="filter-clear-all" onClick={clearAllFilters}>Clear all</span>
        </div>
      )}
      {showFilters && (
        <div className="table-count">{visible.length} of {rows.length} trades</div>
      )}
      <table>
        <thead>
          <tr>
            <th>Date</th>
            {showDayColumn && (
              <th>
                <span className="th-label">Day</span>
                {showFilters && (
                  <ColumnFilter mode="multi" options={dayOptions} value={filterDays} onChange={setFilterDays} />
                )}
              </th>
            )}
            {showInstrumentColumn && <th>Instrument</th>}
            {showStrategyColumn && (
              <th>
                <span className="th-label">Strategy</span>
                {showFilters && (
                  <ColumnFilter mode="multi" options={strategyOptions} value={filterStrategies} onChange={setFilterStrategies} />
                )}
              </th>
            )}
            <th>
              <span className="th-label">Direction</span>
              {showFilters && (
                <ColumnFilter mode="single" options={directionOptions} value={filterDirection} onChange={setFilterDirection} />
              )}
            </th>
            <th>
              <span className="th-label">Result</span>
              {showFilters && (
                <ColumnFilter mode="single" options={resultOptions} value={filterResult} onChange={setFilterResult} />
              )}
            </th>
            {showPnlColumn && <th>P&amp;L</th>}
            <th className="actions-col-header"></th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={colCount}>
                <div className="empty">No trades match these filters.</div>
              </td>
            </tr>
          )}
          {paged.map((t) => {
            const closed = hasResult(t)
            const rClass = !closed ? 'r-zero' : t.r_multiple > 0 ? 'r-pos' : t.r_multiple < 0 ? 'r-neg' : 'r-zero'
            const riskReward = calcRiskReward(t.target_distance, t.stop_distance)
            // The primary exit plus every additional leg, in the order they
            // were entered - same convention TradeForm.js's own numbered
            // exit list uses. A single-leg trade (the common case) skips
            // all of this and renders exactly as before.
            const exitLegs = [
              { exit_time: t.exit_time, exit_price: t.exit_price, contracts: t.contracts },
              ...(t.additional_exits || []),
            ]
            const hasMultipleExits = exitLegs.length > 1
            const totalExitContracts = exitLegs.reduce((sum, leg) => sum + (leg.contracts == null ? 0 : Number(leg.contracts)), 0)
            const lastLeg = exitLegs[exitLegs.length - 1]
            const shots = shotsFor(t)
            const thumbUrls = resolvedThumbnails[t.id] || []
            const isExpanded = expandedId === t.id
            const rowSymbol = showInstrumentColumn ? instrumentSymbolFor?.(t) : symbol
            return (
              <Fragment key={t.id}>
                <tr className="clickable-row" onClick={() => toggleExpand(t)}>
                  <td>{t.trade_date}{showTimeInDate && t.trade_time ? ` ${t.trade_time}` : ''}</td>
                  {showDayColumn && <td>{dayOf(t).toUpperCase()}</td>}
                  {showInstrumentColumn && (
                    <td>
                      <span className="strategy-dot" style={{ background: instrumentColorFor?.(t), marginRight: '8px', verticalAlign: 'middle' }} />
                      {rowSymbol || '—'}
                    </td>
                  )}
                  {showStrategyColumn && (
                    <td>{t.strategy_id ? (strategyNameById?.(t.strategy_id) || '—') : <span className="unclassified-tag">Unassigned</span>}</td>
                  )}
                  <td style={{ color: t.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>
                    {t.direction.toUpperCase()}
                  </td>
                  <td>
                    {closed
                      ? <span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}R</span>
                      : <span className="r-pill r-open">Open</span>}
                  </td>
                  {showPnlColumn && (
                    <td className={t.pnl == null ? '' : t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>{fmtPnl(t.pnl)}</td>
                  )}
                  <td className="row-actions">
                    <span className="row-actions-inner">
                      <Link
                        href={`/app/${rowSymbol}/log/${t.id}/edit`}
                        className="row-action-btn"
                        onClick={(e) => e.stopPropagation()}
                        title="Edit trade"
                      >
                        <Pencil size={15} />
                      </Link>
                      <span
                        className="row-action-btn row-action-danger"
                        onClick={(e) => handleDelete(e, t)}
                        title="Delete trade"
                      >
                        <Trash2 size={15} />
                      </span>
                    </span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="expand-row">
                    <td colSpan={colCount}>
                      <div className="expand-row-detail">
                        <div className="detail-grid trade-expand-grid" style={{ padding: '16px 4px' }}>
                          <div>
                            <label>Entry</label>
                            <div>
                              {fmtNum(t.entry)}
                              <div className="detail-subvalue">
                                {formatTime12h(t.trade_time)}
                                {t.trade_time_unverified && <span className="time-unverified-badge" title="The entry or exit price logged for this trade wasn't seen trading during its own logged minute - double-check the times/prices you entered.">Unverified</span>}
                              </div>
                            </div>
                          </div>
                          <div>
                            <label>Stop loss</label>
                            <div>
                              {fmtNum(t.stop)}
                              {t.stop_distance != null && <div className="detail-subvalue">{fmtNum(t.stop_distance)} pts</div>}
                            </div>
                          </div>
                          <div>
                            <label>Take profit</label>
                            <div>
                              {t.target == null ? '—' : fmtNum(t.target)}
                              {t.target_distance != null && <div className="detail-subvalue">{fmtNum(t.target_distance)} pts</div>}
                            </div>
                          </div>
                          <div>
                            <label>{hasMultipleExits ? 'Exit legs' : 'Exit price'}</label>
                            <div>
                              {hasMultipleExits ? (
                                <ol className="exit-list">
                                  {exitLegs.map((leg, i) => {
                                    const legR = calcRMultiple(t.direction, t.entry, t.stop, parseFloat(leg.exit_price))
                                    return (
                                      <li className="exit-list-item" key={i}>
                                        {fmtNum(leg.exit_price)} ({leg.contracts == null ? '—' : leg.contracts}x)
                                        {legR !== null && (
                                          <span className={legR > 0 ? 'pos' : legR < 0 ? 'neg' : 'neu'}> · {(legR >= 0 ? '+' : '') + legR.toFixed(2)}R</span>
                                        )}
                                      </li>
                                    )
                                  })}
                                </ol>
                              ) : (
                                fmtNum(t.exit_price)
                              )}
                              <div className="detail-subvalue">
                                {formatDuration(tradeDurationMinutes({ trade_time: t.trade_time, exit_time: lastLeg.exit_time }))} · {totalExitContracts} contracts
                              </div>
                            </div>
                          </div>
                          <div>
                            <label>Planned R:R</label>
                            <div>{riskReward === null ? '—' : riskReward.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                          </div>
                          <div>
                            <label>Realised R</label>
                            <div className={!closed ? '' : t.r_multiple > 0 ? 'pnl-pos' : t.r_multiple < 0 ? 'pnl-neg' : ''}>
                              {closed ? (t.r_multiple >= 0 ? '+' : '') + t.r_multiple.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'R' : '—'}
                            </div>
                          </div>
                          <div>
                            <div className="field-label-row"><label>MFE</label><FieldTooltip text={MFE_HINT} /></div>
                            <div>{excursionCell(t, timezoneOffset, formatExcursionPoints(t.mfe_points))}</div>
                          </div>
                          <div>
                            <div className="field-label-row"><label>MAE</label><FieldTooltip text={MAE_HINT} /></div>
                            <div>{excursionCell(t, timezoneOffset, formatExcursionPoints(t.mae_points))}</div>
                          </div>
                          <div>
                            <label>Time in drawdown</label>
                            <div>{excursionCell(t, timezoneOffset, t.market_data_status === 'complete' ? formatDuration(Math.round(t.drawdown_seconds / 60)) : null)}</div>
                          </div>
                        </div>

                        {t.discipline_tags?.length > 0 && (
                          <div className="expand-row-divider">
                            <label className="detail-sublabel">Discipline</label>
                            <div className="tag-row" style={{ marginTop: '4px' }}>
                              {t.discipline_tags.map((tag) => <span className="trade-tag discipline-tag" key={tag}>{tag}</span>)}
                            </div>
                          </div>
                        )}

                        {t.tags?.length > 0 && (
                          <div className="expand-row-divider">
                            <label className="detail-sublabel">Tags</label>
                            <div className="tag-row" style={{ marginTop: '4px' }}>
                              {t.tags.map((tag) => <span className="trade-tag" key={tag}>{tag}</span>)}
                            </div>
                          </div>
                        )}

                        {t.reasoning && (
                          <div className="expand-row-divider">
                            <label className="detail-sublabel">Notes</label>
                            <p style={{ marginTop: '4px', lineHeight: 1.5, fontSize: '13px' }}>{t.reasoning}</p>
                          </div>
                        )}

                        {shots.length > 0 && (
                          <div className="screenshot-grid" style={{ marginTop: '20px' }}>
                            {shots.map((path, i) => (
                              thumbUrls[i] ? (
                                <img
                                  key={path}
                                  src={thumbUrls[i]}
                                  alt={`Trade screenshot ${i + 1}`}
                                  className="thumb"
                                  style={{ width: '70px', height: '70px' }}
                                  onClick={(e) => { e.stopPropagation(); openPreview(t, i) }}
                                />
                              ) : (
                                <div key={path} className="skel skel-thumb" style={{ width: '70px', height: '70px' }} />
                              )
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      {pageSize && visible.length > pageSize && (
        <div className="table-pagination">
          <span
            className={`calendar-nav-btn ${safePage === 0 ? 'nav-btn-disabled' : ''}`}
            onClick={() => safePage > 0 && setPage(safePage - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} />
          </span>
          <span className="table-pagination-page">{safePage + 1}</span>
          <span
            className={`calendar-nav-btn ${safePage >= totalPages - 1 ? 'nav-btn-disabled' : ''}`}
            onClick={() => safePage < totalPages - 1 && setPage(safePage + 1)}
            aria-label="Next page"
          >
            <ChevronRight size={16} />
          </span>
        </div>
      )}

      {preview && (
        <ScreenshotLightbox
          shots={preview.shots}
          index={preview.index}
          onIndexChange={(i) => setPreview((p) => ({ ...p, index: i }))}
          onClose={() => setPreview(null)}
        />
      )}
      {confirmModal}
    </div>
  )
}
