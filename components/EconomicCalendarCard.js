'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Filter } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'
import { fetchEconomicEvents } from '@/lib/econCalendarQuery'
import { IMPACT_LEVELS, EVENT_TYPES, CURRENCIES } from '@/lib/econCalendarEvents.mjs'
import DateRangePicker from '@/components/DateRangePicker'

// One filter setting for "the economic calendar", shared by every instance
// of this card rather than one per page it appears on. Versioned in the key
// name because the stored shape changed from a bare array of impacts to an
// object covering all three sections - an older value under the old key is
// simply ignored rather than needing a migration path.
const FILTER_STORAGE_KEY = 'econCalendarFilters.v2'

// Impacts default to everything except the grey non-economic level, which
// is bank holidays and other "nothing is released here" entries - useful to
// be able to see, noise to have on by default.
//
// Currencies default to USD alone, matching what this app is for: every
// instrument in lib/instrumentCatalog.js is a US futures contract, so a
// default of all nine would bury the releases that actually move them
// under eight other countries' calendars. Every currency is one checkbox
// away for anyone trading the correlations.
const DEFAULT_FILTERS = {
  impacts: ['high', 'medium', 'low'],
  types: EVENT_TYPES,
  currencies: ['USD'],
}

function pad(n) {
  return String(n).padStart(2, '0')
}
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function todayStr() {
  return toDateStr(new Date())
}
// Sunday and Saturday of the current week, in the visitor's local time -
// the default range this card opens to, so it reads as "what's happening
// this week" rather than just today.
function weekStartStr() {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  return toDateStr(d)
}
function weekEndStr() {
  const d = new Date()
  d.setDate(d.getDate() + (6 - d.getDay()))
  return toDateStr(d)
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function formatDateLabel(date) {
  return `${WEEKDAY_ABBR[date.getDay()]} ${date.getDate()}`
}
function formatTimeLabel(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// How many of the three sections are narrowed at all. The button reads
// "Filter" on its own when nothing is, and carries a count when something
// is - the same "show that a filter is on without spelling out all of it"
// job the old impact-only label did, but the old approach of naming every
// selected value doesn't survive three sections and nine currencies.
function activeSectionCount(filters) {
  let n = 0
  if (filters.impacts.length !== IMPACT_LEVELS.length) n++
  if (filters.types.length !== EVENT_TYPES.length) n++
  if (filters.currencies.length !== CURRENCIES.length) n++
  return n
}

// One checkbox group inside the filter panel, with FF's own "(all, none)"
// shortcuts beside the heading. `renderSwatch` is only passed by the
// impact section, which shows the colour FF uses for each level rather
// than relying on the words alone.
function FilterSection({ title, options, selected, onChange, columns = 1, renderSwatch = null }) {
  const values = options.map((o) => o.value)
  function toggle(value) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }
  return (
    <div className="econ-filter-section">
      <div className="econ-filter-section-head">
        <span className="econ-filter-section-title">{title}</span>
        <span className="econ-filter-section-links">
          (
          <button type="button" className="econ-filter-link" onClick={() => onChange(values)}>all</button>
          {', '}
          <button type="button" className="econ-filter-link" onClick={() => onChange([])}>none</button>
          )
        </span>
      </div>
      <div className={`econ-filter-options${columns === 2 ? ' econ-filter-options-2col' : ''}`}>
        {options.map((o) => (
          <label key={o.value} className="econ-filter-option">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            {renderSwatch ? renderSwatch(o) : null}
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// Replaces the old impact-only dropdown: one Filter button opening a panel
// covering all three of FF's own filter dimensions at once. Same open/close
// behaviour as every other popover in this app (outside click, Escape via
// useClickOutside, and closing on scroll so it can't detach from a button
// that has scrolled away).
function CalendarFilterMenu({ filters, onChange }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)
  const activeCount = activeSectionCount(filters)

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    // capture:true so this sees scrolling inside the panel's own
    // ancestors too, but ignoring scrolls that start inside the panel
    // itself - the options list scrolls internally on a short viewport,
    // and closing the list being scrolled is the bug that pattern exists
    // to avoid (see TradeLogTable's TagFilterMenu, which hit it first).
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
  }, [open, wrapRef])

  return (
    <div className="econ-impact-filter" ref={wrapRef}>
      <button
        type="button"
        className="calendar-strategy-filter econ-impact-filter-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Filter size={14} />
        Filter
        {activeCount > 0 && <span className="econ-filter-count">{activeCount}</span>}
      </button>
      {open && (
        <div className="econ-filter-panel">
          {/* Impact and Event Types stack in one column, Currencies runs
              down its own beside them - the arrangement FF's own filter
              panel uses. */}
          <div className="econ-filter-col">
            <FilterSection
              title="Expected Impact"
              options={IMPACT_LEVELS}
              selected={filters.impacts}
              onChange={(impacts) => onChange({ ...filters, impacts })}
              renderSwatch={(o) => <span className={`econ-impact-swatch econ-impact-${o.value}`} />}
            />
            <FilterSection
              title="Event Types"
              options={EVENT_TYPES.map((t) => ({ value: t, label: t }))}
              selected={filters.types}
              onChange={(types) => onChange({ ...filters, types })}
              columns={2}
            />
          </div>
          <div className="econ-filter-col">
            <FilterSection
              title="Currencies"
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
              selected={filters.currencies}
              onChange={(currencies) => onChange({ ...filters, currencies })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// Backed by economic_events, refreshed hourly from Forex Factory's own
// published calendar feeds (scripts/fetch-economic-calendar.js). This card
// used to render a hardcoded week from lib/marketContextMock.js that
// repeated itself forever; everything on screen here is now real, including
// each release's actual once it prints.
export default function EconomicCalendarCard() {
  const [fromDate, setFromDate] = useState(weekStartStr)
  const [toDate, setToDate] = useState(weekEndStr)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Identifies the most recent load so a slower earlier one can't land on
  // top of it - clicking through the date picker changes the range several
  // times in a row, and without this the first (widest, slowest) range's
  // results could arrive last and overwrite the range actually on screen.
  const loadIdRef = useRef(0)

  // Restores whatever the trader last set. This component only ever mounts
  // client-side (the dashboard gates it behind its own loading state), so
  // there's no SSR/hydration mismatch to defer around.
  useEffect(() => {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      // Field by field, not a wholesale replace: a stored value written by
      // an older version of this card (or hand-edited) shouldn't be able
      // to leave a section undefined and crash every .includes() below.
      setFilters({
        impacts: Array.isArray(parsed?.impacts) ? parsed.impacts : DEFAULT_FILTERS.impacts,
        types: Array.isArray(parsed?.types) ? parsed.types : DEFAULT_FILTERS.types,
        currencies: Array.isArray(parsed?.currencies) ? parsed.currencies : DEFAULT_FILTERS.currencies,
      })
    } catch {
      // Malformed value - fall back to the defaults already set above.
    }
  }, [])

  // Only the date range is a query input; the three filter sections narrow
  // what's already been fetched, so toggling a checkbox is instant rather
  // than a round trip.
  useEffect(() => {
    let cancelled = false
    const loadId = ++loadIdRef.current

    async function load() {
      setLoading(true)
      const { data, error: queryError } = await fetchEconomicEvents(fromDate, toDate)
      if (cancelled || loadId !== loadIdRef.current) return
      if (queryError) {
        setError("Couldn't load the economic calendar.")
        setEvents([])
      } else {
        setError(null)
        setEvents(data || [])
      }
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [fromDate, toDate])

  function handleFilterChange(next) {
    setFilters(next)
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next))
  }

  const isSingleDay = fromDate === toDate
  const today = todayStr()

  const visible = events.filter((e) => (
    filters.impacts.includes(e.impact)
    && filters.types.includes(e.event_type)
    && filters.currencies.includes(e.currency)
  ))

  return (
    <>
      <div className="calendar-toolbar">
        <CalendarFilterMenu filters={filters} onChange={handleFilterChange} />
        <DateRangePicker from={fromDate} to={toDate} onChange={(f, t) => { setFromDate(f); setToDate(t) }} />
      </div>

      {loading ? (
        <div className="econ-calendar-list">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="econ-calendar-row" key={i}>
              <div className="skel skel-line" style={{ width: `${70 - i * 8}%` }} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="empty">{error}</div>
      ) : visible.length === 0 ? (
        <div className="empty">
          {events.length === 0
            ? 'No events in this range.'
            : 'No events match these filters.'}
        </div>
      ) : (
        <div className="econ-calendar-list">
          {visible.map((e) => {
            const at = new Date(e.event_time)
            const dateStr = toDateStr(at)
            return (
              <div
                className={`econ-calendar-row ${!isSingleDay && dateStr === today ? 'econ-calendar-row-today' : ''}`}
                key={e.event_key}
              >
                <span className={`econ-impact-dot econ-impact-${e.impact}`} />
                {!isSingleDay && <span className="econ-calendar-day">{formatDateLabel(at)}</span>}
                <span className="econ-calendar-time">{formatTimeLabel(at)}</span>
                <span className="econ-calendar-currency">{e.currency}</span>
                <span className="econ-calendar-event">{e.title}</span>
                <span className="econ-calendar-figures">
                  {e.actual !== null && e.actual !== undefined && (
                    <span className="econ-figure-actual">act {e.actual}</span>
                  )}
                  {e.forecast ? <span>fcst {e.forecast}</span> : null}
                  {e.previous ? <span>prev {e.previous}</span> : null}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
