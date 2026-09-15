'use client'

import { useState, useEffect } from 'react'
import { fetchEconomicEvents } from '@/lib/econCalendarQuery'
import { isAllDay, displayDayFor, localDayOf } from '@/lib/econCalendarDay'

// The per-instrument dashboard's "Next calendar event" card, off real
// economic_events instead of lib/marketContextMock's repeating week.
//
// The mock was a fixed list of eight releases keyed to weekday, replayed
// every week forever - so the card counted down to a CPI print that was
// not scheduled, on a day it was not scheduled for, and kept doing it
// after the real one had come and gone. It was placeholder data doing a
// convincing impression of live data, which is the worst kind.
//
// WHY USD AND HIGH/MEDIUM ONLY. Every instrument in lib/instrumentCatalog
// is a US-listed future - the index contracts, gold, crude, bitcoin - so a
// Swiss PPI print is not what moves the chart the trader is looking at.
// USD matches the Economic calendar card's own default filter, so the two
// surfaces agree about what is worth interrupting someone for. The impact
// cut is the same one lib/useCalendarNewsByDay makes and for the same
// reason: the table holds ~14 releases a day, and a card listing all of
// them is a card nobody reads. High and medium is about three.
const CURRENCY = 'USD'
const IMPACTS = ['high', 'medium']
const WINDOW_MS = 24 * 60 * 60 * 1000

// What the card should show, given rows and a clock. Pure and exported so
// it can be tested directly - the hook around it needs a React renderer
// this repo deliberately doesn't have (see CLAUDE.md on lib/*.test.js).
//
// All-day rows are kept rather than filtered out, and marked. A US bank
// holiday is one of the more consequential things a futures dashboard can
// say - thin liquidity, an early close - so dropping it because the card's
// layout happens to be a countdown would let the layout decide the
// content. It cannot be counted down to, having no time of its own, so it
// carries allDay and the card renders a label in that slot instead.
//
// They are selected by DAY, not by instant: an all-day row is stored at
// midnight in FF's zone, so for a viewer west of FF its instant has
// already passed while the day itself is still ahead - exactly the
// mismatch lib/econCalendarDay exists to settle. Compared against the
// viewer's own today and tomorrow, which is the same span the 24-hour
// window covers for timed rows.
export function selectUpcoming(events, now = new Date(), windowMs = WINDOW_MS) {
  if (!Array.isArray(events)) return []
  const nowMs = now.getTime()
  const cutoff = nowMs + windowMs
  const today = localDayOf(now)
  const tomorrow = localDayOf(new Date(nowMs + 24 * 60 * 60 * 1000))

  const chosen = []
  for (const event of events) {
    if (event?.currency !== CURRENCY) continue
    if (!IMPACTS.includes(event?.impact)) continue

    if (isAllDay(event)) {
      const day = displayDayFor(event)
      if (day !== today && day !== tomorrow) continue
      chosen.push({ event, allDay: true, timestamp: null, sortAt: dayStartMs(day) })
      continue
    }

    const at = Date.parse(event?.event_time)
    if (Number.isNaN(at) || at <= nowMs || at > cutoff) continue
    chosen.push({ event, allDay: false, timestamp: new Date(at), sortAt: at })
  }

  // An all-day row sorts to the start of its own day, which puts today's
  // holiday above this afternoon's release and tomorrow's below it -
  // where FF itself puts them.
  return chosen.sort((a, b) => a.sortAt - b.sortAt)
}

function dayStartMs(day) {
  const at = Date.parse(`${day}T00:00:00`)
  return Number.isNaN(at) ? 0 : at
}

// `loading` is not decoration. The mock resolved synchronously, so the
// card always had an answer to render; a real fetch does not, and an empty
// array during the first load would render "No events in the next 24
// hours" - a specific factual claim, made before anything had been read.
// CLAUDE.md's note about the mock hiding timing bugs is exactly this case.
// How often the card's own clock advances. A countdown computed once at
// render is not a countdown - it is a number that was true when the page
// loaded and quietly stops being true, which on a card whose whole content
// is "how long until this" is worse than showing nothing. A minute is the
// resolution fmtCountdown actually prints, so anything finer would re-render
// the page to produce identical text.
const TICK_MS = 60 * 1000

export function useUpcomingEconEvents() {
  const [state, setState] = useState({ events: [], loading: true, error: false })
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  // Both ends of the query window as local day strings, which is what
  // fetchEconomicEvents takes. A day either side of the 24-hour window,
  // because the window can straddle midnight and because an all-day row's
  // instant can sit outside the local day it belongs to.
  //
  // Derived from the ticking clock, so a dashboard left open across
  // midnight re-queries for the new day instead of counting down into a
  // window that ended hours ago. The deps are the day STRINGS, not the
  // clock, so the every-minute tick re-renders the countdown without
  // re-issuing the query.
  const fromDay = localDayOf(now)
  const toDay = localDayOf(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000))

  useEffect(() => {
    if (!fromDay || !toDay) return undefined
    let cancelled = false

    async function load() {
      const { data, error } = await fetchEconomicEvents(fromDay, toDay)
      if (cancelled) return
      // A dashboard that cannot reach the table still shows every trade,
      // which is what the page is for. So this says so in the card rather
      // than failing the page - and says it distinctly from "no events",
      // which is a different fact.
      setState(error
        ? { events: [], loading: false, error: true }
        : { events: data || [], loading: false, error: false })
    }

    load()
    return () => { cancelled = true }
  }, [fromDay, toDay])

  // The clock comes back out with the rows so the card counts down against
  // the same instant the selection was made against. Two clocks a minute
  // apart would eventually render "0m" beside a row already filtered out.
  return { ...state, upcoming: selectUpcoming(state.events, now), now }
}
