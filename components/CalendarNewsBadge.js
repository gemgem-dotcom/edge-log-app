'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Newspaper } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'

// Small icon in a Monthly P&L day cell's corner when notable news landed
// that day - click opens a popover listing them. Fixed-positioned
// (computed from the trigger's own bounding rect) rather than absolute,
// same reason as ColumnFilter.js: the calendar grid can end up inside a
// horizontally-scrolling ancestor on narrow viewports, which would
// otherwise clip it.
//
// Takes its events rather than fetching them. It used to read a hardcoded
// week from lib/marketContextMock.js that repeated forever, so every
// weekday of every month - including months years in the past - carried a
// badge claiming the same eight releases. Now the parent fetches the
// visible month once (lib/useCalendarNewsByDay.js) and hands each cell its
// own day; forty-two cells each running a query would be the obvious way
// to get this wrong.
function formatEventTime(event) {
  // Same rule as the Economic calendar card: an all-day or tentative row
  // is anchored to its day's midnight, and printing "00:00" would dress
  // that placeholder up as a schedule.
  if (event.time_precision && event.time_precision !== 'exact') {
    return event.time_precision === 'tentative' ? 'tent.' : 'all day'
  }
  const at = new Date(event.event_time)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export default function CalendarNewsBadge({ events = [] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  if (events.length === 0) return null

  function handleClick(e) {
    e.stopPropagation()
    if (open) { setOpen(false); return }
    const rect = btnRef.current.getBoundingClientRect()
    setPos({ left: rect.left, top: rect.bottom + 6 })
    setOpen(true)
  }

  return (
    <span className="calendar-news-badge-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="calendar-news-badge"
        onClick={handleClick}
        aria-label={`${events.length} economic event${events.length === 1 ? '' : 's'} on this day`}
      >
        <Newspaper size={10} />
      </button>
      {open && pos && (
        <div className="col-filter-menu calendar-news-popover" style={{ left: `${pos.left}px`, top: `${pos.top}px` }} onClick={(e) => e.stopPropagation()}>
          {events.map((e) => (
            <div className="calendar-news-popover-row" key={e.event_key}>
              <span className={`econ-impact-dot econ-impact-${e.impact}`} />
              <span className="calendar-news-popover-time">{formatEventTime(e)}</span>
              {/* Currency earns its place now that these are real: the
                  badge covers every currency, so "CPI m/m" alone doesn't
                  say whose. */}
              <span className="calendar-news-popover-cur">{e.currency}</span>
              <span className="calendar-news-popover-event">{e.title}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
