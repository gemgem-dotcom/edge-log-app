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
function monthBound(year, month, padDays, fromEndOfMonth) {
  const d = fromEndOfMonth ? new Date(year, month + 1, 0) : new Date(year, month, 1)
  d.setDate(d.getDate() + padDays)
  return toLocalDayStr(d)
}

export function useCalendarNewsByDay(year, month) {
  const [byDay, setByDay] = useState({})
  const fromDateStr = monthBound(year, month, -7, false)
  const toDateStr = monthBound(year, month, 7, true)

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
  }, [fromDateStr, toDateStr])

  return byDay
}
