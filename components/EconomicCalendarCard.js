'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Filter } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
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

// How often an open card asks the server to re-read Forex Factory, so a
// release that prints while someone is watching appears without a reload.
// The server applies its own shared cooldown on top of this (see
// app/api/economic-calendar/refresh/route.js), so this interval is a
// ceiling on how live the card is, not on how often FF gets fetched.
const LIVE_REFRESH_MS = 60_000

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

// How many of the three sections are hiding something. The button carries
// that count beside the word "Filter" - the same "show that a filter is on
// without spelling out all of it" job the old impact-only label did, since
// naming every selected value doesn't survive three sections and nine
// currencies.
// Membership, not length. A stored value whose arrays are the right SIZE
// but hold names that aren't options any more - an older version's event
// types, a hand-edited key - counted as "nothing narrowed", so the button
// read a bare "Filter" while the card below it said "No events match these
// filters". Asking whether every option is actually selected can't be
// fooled that way.
function isNarrowed(selected, allOptions) {
  return !allOptions.every((option) => selected.includes(option))
}

// Note this counts against the FULL option list, not against
// DEFAULT_FILTERS, so a fresh install opens showing 2 - impacts exclude
// the grey holiday level and currencies start at USD alone. That is the
// truth the badge is for: two sections really are hiding events, and the
// trader has no other way to know it before opening the panel.
function activeSectionCount(filters) {
  let n = 0
  if (isNarrowed(filters.impacts, IMPACT_LEVELS.map((i) => i.value))) n++
  if (isNarrowed(filters.types, EVENT_TYPES)) n++
  if (isNarrowed(filters.currencies, CURRENCIES)) n++
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

// Backed by economic_events, refreshed hourly by
// scripts/fetch-economic-calendar.js from forexfactory.com/calendar's own
// HTML. This card used to render a hardcoded week from
// lib/marketContextMock.js that repeated itself forever; everything on
// screen here is now real, including each release's actual once it prints
// and FF's own marking of whether that beat or missed forecast.
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
      // Only a newer RANGE can make this result stale, and that also sets
      // `cancelled`. The quiet reload below no longer bumps the counter,
      // so it can't invalidate this load - which is what stops the card
      // both from wedging on the skeleton and from flashing an empty
      // state: whichever of the two lands, the range on screen gets rows.
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

  // The re-read the live refresh below uses. Deliberately separate from
  // the effect above rather than a shared loader with a `quiet` flag: this
  // one never touches the loading flag, because dropping the whole card
  // back to a skeleton every minute would be worse than the staleness it's
  // fixing. Keeping the two apart also keeps the effect above free of a
  // setState called synchronously through a useCallback, which React flags
  // as a cascading render.
  //
  // It OBSERVES the load counter without bumping it. Bumping made this
  // invalidate the initial load, which then finished without rendering
  // anything - so the card cleared its skeleton onto "No events in this
  // range." until this request came back. Both requests ask for the same
  // range, so neither is stale next to the other; the counter is only
  // there to stop a reply for a range the trader has already moved off.
  const reloadQuietly = useCallback(async () => {
    const loadId = loadIdRef.current
    const { data, error: queryError } = await fetchEconomicEvents(fromDate, toDate)
    if (loadId !== loadIdRef.current || queryError) return
    // Clears a stale error too: the render order puts `error` ahead of the
    // rows, so without this one failed load left the card apologising
    // forever while every refresh since had quietly succeeded.
    setError(null)
    setEvents(data || [])
  }, [fromDate, toDate])

  // Live refresh: ask the server to re-read Forex Factory, then re-read the
  // table. Runs on mount and every minute the card stays open, so a figure
  // that prints while someone is watching lands without a reload.
  //
  // Only ever the current week's data is refreshed server-side, so this
  // does nothing useful when the trader has paged back to an older range -
  // and the re-read is skipped in that case rather than issuing a query
  // whose answer cannot have changed.
  useEffect(() => {
    const rangeIncludesToday = fromDate <= todayStr() && todayStr() <= toDate
    if (!rangeIncludesToday) return

    let cancelled = false

    async function refresh() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session || cancelled) return
        const res = await fetch('/api/economic-calendar/refresh', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        await res.json().catch(() => ({}))
        // Re-read whatever the answer was. Gating this on `refreshed` was
        // wrong in the one case it was meant to optimise: a cooldown means
        // somebody ELSE just refreshed - the hourly job, or another trader
        // with the dashboard open - so the table has moved and this card's
        // copy of it hasn't. Skipping the re-read meant the second viewer
        // never saw a new actual for as long as the card stayed open. The
        // re-read is one indexed range query; the fetch it might have
        // avoided is the expensive half, and the server already refused it.
        if (!cancelled) await reloadQuietly()
      } catch {
        // A missed refresh is not worth surfacing - the card still has
        // whatever the scheduled job last stored.
      }
    }

    refresh()
    const id = setInterval(refresh, LIVE_REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [fromDate, toDate, reloadQuietly])

  function handleFilterChange(next) {
    setFilters(next)
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next))
  }

  const isSingleDay = fromDate === toDate
  const today = todayStr()

  const visible = events.filter((e) => (
    filters.impacts.includes(e.impact)
    && filters.types.includes(e.event_type)
    // Only currencies that HAVE a checkbox are filtered by currency. Two
    // kinds of row don't: a GLOBAL_CURRENCY event (OPEC, G20), which isn't
    // any one country's news so unticking EUR shouldn't hide it, and a
    // currency outside CURRENCIES entirely - a tenth code FF adds, or a
    // feed record with the field missing. Filtering those by a checkbox
    // that doesn't exist made them permanently invisible with nothing on
    // screen to say so; showing them is the failure a trader can actually
    // see and report. Impact and event type still apply to both.
    && (!CURRENCIES.includes(e.currency) || filters.currencies.includes(e.currency))
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
        <>
          {/* Actual/Forecast/Previous are their own aligned columns rather
              than labelled inline, so the three figures line up down the
              card and can be compared at a glance. That only works with a
              header saying which is which - without the old "act"/"fcst"
              prefixes the numbers are ambiguous on their own. */}
          <div className="econ-calendar-list">
            {/* Inside the scrolling list, not above it. As a sibling its
                right edge was the panel's, while every row's was the
                panel's minus the list's padding and minus the scrollbar -
                so the three figure columns sat 10px (16px once a scrollbar
                appeared) to the left of the headings naming them. Sharing
                one scroll box makes that arithmetic identical for both by
                construction, and sticky keeps the headings in view in a
                list only five rows tall.

                Not aria-hidden. It was, back when each row still carried
                its own "act"/"fcst"/"prev" prefixes and this was pure
                duplication; removing those prefixes made this the only
                thing naming the three figures, so hiding it left a screen
                reader reading out three bare numbers per row. */}
            <div className="econ-calendar-head">
              {!isSingleDay && <span className="econ-calendar-day">Date</span>}
              <span className="econ-calendar-time">Time</span>
              <span className="econ-calendar-currency">Cur</span>
              <span className="econ-calendar-event">Event</span>
              <span className="econ-calendar-figure">Actual</span>
              <span className="econ-calendar-figure">Forecast</span>
              <span className="econ-calendar-figure">Previous</span>
            </div>
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
                  {/* An all-day or tentative release is stored anchored to
                      its day's midnight because that is the only honest
                      thing its timestamp can say. Printing "00:00" would
                      dress that placeholder up as a schedule, so it gets
                      FF's own wording instead. */}
                  <span className="econ-calendar-time">
                    {e.time_precision && e.time_precision !== 'exact'
                      ? (e.time_precision === 'tentative' ? 'tent.' : 'all day')
                      : formatTimeLabel(at)}
                  </span>
                  <span className="econ-calendar-currency">{e.currency}</span>
                  <span className="econ-calendar-event">{e.title}</span>
                  {/* better/worse is FF's own comparison against its own
                      forecast, carried through rather than recomputed -
                      "better" is not always "higher" (an unemployment print
                      beats by falling), so it's a judgement only the source
                      can make. */}
                  <span className={`econ-calendar-figure${e.actual ? ' econ-figure-actual' : ''}${e.actual && e.actual_status ? ` econ-figure-${e.actual_status}` : ''}`}>
                    {/* The emphasis classes are only applied when there IS
                        an actual - otherwise the placeholder dash renders
                        bolder than the real figures around it. */}
                    {e.actual ?? '–'}
                  </span>
                  <span className="econ-calendar-figure">{e.forecast ?? '–'}</span>
                  <span className="econ-calendar-figure">
                    {e.previous ?? '–'}
                    {e.previous_revised && <span className="econ-figure-revised" title="Revised since first published">*</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}
