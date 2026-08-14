'use client'

import { useState, useCallback, useEffect } from 'react'
import { Clock, ChevronUp, ChevronDown } from 'lucide-react'
import { useClickOutside } from '../lib/useClickOutside'
import { useIsMobile } from '../lib/useIsMobile'

function pad(n) { return String(n).padStart(2, '0') }

// value is 24-hour "HH:MM:SS" - the same format the native
// input[type=time] stores regardless of how it displays, so
// tradeDurationMinutes and everything else reading trade_time/exit_time
// needed no changes. Trades logged before step="1" existed only stored
// "HH:MM", so seconds isn't just possibly NaN (a bad 3rd segment) but
// possibly missing entirely - Number.isNaN(undefined) is false, so that
// alone won't catch it.
function parseTime(value) {
  if (!value) return null
  const [h, m, s] = value.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return { h, m, s: Number.isFinite(s) ? s : 0 }
}

function to12Hour(h) {
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return { h12, period }
}

function from12Hour(h12, period) {
  const h = h12 % 12
  return period === 'PM' ? h + 12 : h
}

function formatDisplay12h(value) {
  const t = parseTime(value)
  if (!t) return ''
  const { h12, period } = to12Hour(t.h)
  return `${pad(h12)}:${pad(t.m)}:${pad(t.s)} ${period}`
}

// The native input[type=time] handles typing itself on desktop - whether
// that shows 12-hour with AM/PM or 24-hour is the browser's own locale
// choice, not something a page can force either way. This adds an
// alternative, optional way to set the same value: a spinner popup, always
// in 12-hour with an AM/PM toggle regardless of what the native segments
// show, since the native popup itself can't be restyled (see the
// color-scheme comment in globals.css).
//
// Real mobile browsers don't support typing into input[type=time] at all -
// tapping it opens the OS's own picker with no keyboard entry - so below
// the app's mobile breakpoint, typing isn't offered here at all: tapping
// the field opens the spinner directly (its up/down buttons are the only
// way to set a time on mobile), rather than swapping in a typed fallback
// like DatePicker does.
export default function TimePicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(open, useCallback(() => setOpen(false), []))
  const isMobile = useIsMobile()

  const parsed = parseTime(value)
  const { h12, period } = parsed ? to12Hour(parsed.h) : { h12: null, period: null }
  const minute = parsed ? parsed.m : null
  const second = parsed ? parsed.s : null

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    const dismissOnScroll = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      dismiss()
    }
    // On mobile, tapping this field blurs whatever had focus before it,
    // which closes the on-screen keyboard if it was open - and that
    // shrinks-then-grows the visual viewport, firing a 'resize' right as
    // this popup opens. Width, unlike height, doesn't change when a
    // keyboard opens or closes - only on an actual orientation change or
    // window resize, which is what should still dismiss it.
    const initialWidth = window.innerWidth
    const dismissOnResize = () => {
      if (window.innerWidth !== initialWidth) dismiss()
    }
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', dismissOnScroll, true)
      window.addEventListener('resize', dismissOnResize)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', dismissOnResize)
    }
  }, [open, ref])

  function commit(next) {
    onChange(`${pad(next.h)}:${pad(next.m)}:${pad(next.s)}`)
  }

  // Any segment nudged before the others starts from a plain default
  // (12:00:00 AM) rather than requiring every segment to be set in order.
  const base = parsed || { h: 0, m: 0, s: 0 }
  const wrap = (n, size) => ((n % size) + size) % size

  function bumpHour(delta) {
    const currentH12 = parsed ? h12 : 12
    const currentPeriod = parsed ? period : 'AM'
    const newH12 = wrap(currentH12 - 1 + delta, 12) + 1
    commit({ ...base, h: from12Hour(newH12, currentPeriod) })
  }
  function bumpMinute(delta) {
    commit({ ...base, m: wrap((parsed ? minute : 0) + delta, 60) })
  }
  function bumpSecond(delta) {
    commit({ ...base, s: wrap((parsed ? second : 0) + delta, 60) })
  }
  function togglePeriod() {
    const currentPeriod = parsed ? period : 'AM'
    const currentH12 = parsed ? h12 : 12
    commit({ ...base, h: from12Hour(currentH12, currentPeriod === 'AM' ? 'PM' : 'AM') })
  }

  const spinCol = (label, display, onUp, onDown) => (
    <div className="dt-picker-spin-col">
      <button type="button" className="dt-picker-spin-btn" aria-label={`Increase ${label}`} onClick={onUp}><ChevronUp size={14} /></button>
      <div className="dt-picker-spin-value">{display}</div>
      <button type="button" className="dt-picker-spin-btn" aria-label={`Decrease ${label}`} onClick={onDown}><ChevronDown size={14} /></button>
    </div>
  )

  return (
    <div className="dt-picker" ref={ref}>
      <div className="dt-picker-trigger">
        {isMobile ? (
          <input
            type="text" readOnly inputMode="none" className="dt-picker-input" placeholder="--:--:-- --"
            value={value ? formatDisplay12h(value) : ''}
            onClick={() => setOpen(true)} onFocus={() => setOpen(true)}
          />
        ) : (
          <input
            type="time" step="1" className="dt-picker-native-input"
            value={value || ''} onChange={(e) => onChange(e.target.value)}
          />
        )}
        <button type="button" className="dt-picker-icon-btn" aria-label="Open time picker" onClick={() => setOpen((v) => !v)}>
          <Clock size={15} />
        </button>
      </div>
      {open && (
        <div className="dt-picker-popup dt-picker-popup-time">
          <div className="dt-picker-time-cols">
            {spinCol('hour', pad(h12 ?? 12), () => bumpHour(1), () => bumpHour(-1))}
            <span className="dt-picker-spin-sep">:</span>
            {spinCol('minute', pad(minute ?? 0), () => bumpMinute(1), () => bumpMinute(-1))}
            <span className="dt-picker-spin-sep">:</span>
            {spinCol('second', pad(second ?? 0), () => bumpSecond(1), () => bumpSecond(-1))}
            {spinCol('AM/PM', period ?? 'AM', togglePeriod, togglePeriod)}
          </div>
        </div>
      )}
    </div>
  )
}
