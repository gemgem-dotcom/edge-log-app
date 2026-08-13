'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Newspaper } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'
import { mockEventsForDate } from '@/lib/marketContextMock'

// Small icon in a Monthly P&L day cell's corner when mock news landed that
// day - click opens a popover listing them. Fixed-positioned (computed
// from the trigger's own bounding rect) rather than absolute, same reason
// as ColumnFilter.js: the calendar grid can end up inside a horizontally-
// scrolling ancestor on narrow viewports, which would otherwise clip it.
export default function CalendarNewsBadge({ dateStr }) {
  const events = mockEventsForDate(dateStr)
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
          {events.map((e, i) => (
            <div className="calendar-news-popover-row" key={i}>
              <span className={`econ-impact-dot econ-impact-${e.impact}`} />
              <span className="calendar-news-popover-time">{e.time}</span>
              <span className="calendar-news-popover-event">{e.event}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
