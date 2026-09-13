'use client'

import { useState, useEffect } from 'react'
import { fetchEconomicEvents } from '@/lib/econCalendarQuery'

// Groups real economic_events into the Monthly P&L calendar's day cells,
// so CalendarNewsBadge can mark a day without each of the ~42 cells
// issuing its own query. One fetch per visible month, keyed on the grid's
// own first and last day (which overhang the month - the grid always shows
// a few days either side).
//
// WHY ONLY HIGH AND MEDIUM IMPACT. The table holds every release Forex
// Factory lists, which is about fourteen a day once low-impact bond
// auctions and tertiary prints are counted. A badge on every single
// weekday says nothing - that was the actual complaint about the mock data
// this replaces, which put a newspaper icon on all five weekdays forever.
// High and medium together run to roughly three a day, which is both a
// readable popover and a truthful answer to "was there market-moving news
// that day?". Low and the grey holiday level are deliberately excluded;
// the full list is one click away on the Economic calendar card.
const BADGE_IMPACTS = ['high', 'medium']

function toLocalDayStr(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Takes the month the grid is showing, not a date range, so neither
// caller has to re-derive how far the grid overhangs its month - it always
// shows a few days of the neighbouring ones. A week of padding either side
// cannot come up short, and the extra fortnight is a rounding error
// against a query that already spans a month.
//
// Returns a plain object keyed by local day, because the caller looks one
// day up per cell and an object lookup is the cheapest thing that can be.
// How long until the next local midnight. Exported so it can be tested
// as the pure function it is - the hook around it needs a React renderer
// this repo deliberately doesn't have (see CLAUDE.md on lib/*.test.js
// being pure-function coverage).
//
// Counted to the next midnight rather than "24 hours from now" because the
// thing that goes stale is the calendar day: a dashboard opened at 11pm
// should pick up tomorrow's events an hour later, not the following
// evening. A second of slack past midnight keeps a fractionally early
// timer from computing the day it just left.
export function msUntilNextLocalMidnight(now = new Date()) {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return next.getTime() - now.getTime() + 1000
}

function monthBound(year, month, padDays, fromEndOfMonth) {
  const d = fromEndOfMonth ? new Date(year, month + 1, 0) : new Date(year, month, 1)
  d.setDate(d.getDate() + padDays)
  return toLocalDayStr(d)
}

export function useCalendarNewsByDay(year, month) {
  const [byDay, setByDay] = useState({})
  // Bumped at every local midnight to re-run the fetch below. Forex
  // Factory keeps revising what this table holds - a forecast is updated,
  // an actual prints, a release is moved to another day - so a dashboard
  // left open across a night would otherwise keep showing the badges it
  // loaded yesterday, for days.
  //
  // A counter rather than today's date, because it always changes: if the
  // timer ever fired a moment early, a date-valued state would be set to
  // the value it already held, React would skip the render, and the
  // re-arm below would never run again.
  const [dayTick, setDayTick] = useState(0)
  const fromDateStr = monthBound(year, month, -7, false)
  const toDateStr = monthBound(year, month, 7, true)

  useEffect(() => {
    const id = setTimeout(() => setDayTick((n) => n + 1), msUntilNextLocalMidnight())
    return () => clearTimeout(id)
  }, [dayTick])

  useEffect(() => {
    if (!fromDateStr || !toDateStr) return undefined
    let cancelled = false

    async function load() {
      const { data, error } = await fetchEconomicEvents(fromDateStr, toDateStr)
      if (cancelled) return
      if (error) {
        // A calendar that can't reach the table still shows every trade,
        // which is what the page is actually for - so this drops the
        // badges and says nothing rather than failing the month.
        setByDay({})
        return
      }
      const grouped = {}
      for (const event of data || []) {
        if (!BADGE_IMPACTS.includes(event.impact)) continue
        // Grouped by the viewer's own local day, matching how the grid
        // builds cell.dateStr. An 8:30pm Chicago release is a different
        // calendar day in London, and the badge has to sit on the day the
        // trader sees it under.
        const day = toLocalDayStr(new Date(event.event_time))
        if (!grouped[day]) grouped[day] = []
        grouped[day].push(event)
      }
      setByDay(grouped)
    }

    load()
    return () => { cancelled = true }
  }, [fromDateStr, toDateStr, dayTick])

  return byDay
}
