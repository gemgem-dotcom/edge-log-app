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

// Lenient typed-text parser for the mobile fallback below: "9:35:00 am",
// "0935 pm", "21:35" (no am/pm -> 24-hour) all parse. Minute/second
// default to 0 when left off entirely.
function parseTypedTime(text) {
  const t = text.trim().toLowerCase()
  const m = t.match(/^(\d{1,2})(?::?(\d{1,2}))?(?::?(\d{1,2}))?\s*(am|pm)?$/)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] !== undefined ? Number(m[2]) : 0
  const sec = m[3] !== undefined ? Number(m[3]) : 0
  const period = m[4]
  if (min > 59 || sec > 59) return null
  if (period) {
    if (h < 1 || h > 12) return null
    h = from12Hour(h, period.toUpperCase())
  } else if (h > 23) {
    return null
  }
  return `${pad(h)}:${pad(min)}:${pad(sec)}`
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
// tapping it opens the OS's own picker with no keyboard entry and no
// placeholder - so below the app's mobile breakpoint this swaps in a
// plain typed text field instead (always 12-hour, matching the spinner),
// restoring manual entry there.
export default function TimePicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(open, useCallback(() => setOpen(false), []))
  const isMobile = useIsMobile()

  const [text, setText] = useState(formatDisplay12h(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setText(formatDisplay12h(value))
  }, [value, editing])

  function handleTextChange(e) {
    setText(e.target.value)
  }
  function handleTextFocus() {
    setEditing(true)
  }
  function handleTextBlur() {
    setEditing(false)
    if (text.trim() === '') { onChange(''); return }
    const parsed = parseTypedTime(text)
    if (parsed) {
      onChange(parsed)
      setText(formatDisplay12h(parsed))
    } else {
      setText(formatDisplay12h(value))
    }
  }

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
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', dismissOnScroll, true)
      window.addEventListener('resize', dismiss)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', dismiss)
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
            type="text" inputMode="text" className="dt-picker-input" placeholder="--:--:-- --"
            value={text} onChange={handleTextChange} onFocus={handleTextFocus} onBlur={handleTextBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
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
