'use client'

import { useState, useCallback, useEffect } from 'react'
import { Clock, ChevronUp, ChevronDown } from 'lucide-react'
import { useClickOutside } from '../lib/useClickOutside'

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

// The field itself is never typed into directly, on any platform - tapping
// it opens a spinner popup instead (always 12-hour with an AM/PM toggle,
// where hour/minute/second are themselves typable - tapping one opens the
// numeric keypad, see spinCol below). This used to be a real native
// input[type=time] on desktop (whose typing works well there) with this
// tap-to-open behavior only below the app's mobile breakpoint, since real
// mobile browsers don't support typing into input[type=time] at all
// (tapping it opens the OS's own unstylable picker). That split kept
// producing behavior that only worked on one platform at a time, so both
// now always use this one implementation.
export default function TimePicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(open, useCallback(() => setOpen(false), []))

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
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

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
  function setHourValue(v) {
    const currentPeriod = parsed ? period : 'AM'
    commit({ ...base, h: from12Hour(clamp(v, 1, 12), currentPeriod) })
  }
  function setMinuteValue(v) {
    commit({ ...base, m: clamp(v, 0, 59) })
  }
  function setSecondValue(v) {
    commit({ ...base, s: clamp(v, 0, 59) })
  }

  // Lets hour/minute/second be typed directly (tapping one opens the
  // numeric keypad on mobile) as well as nudged via the up/down arrows.
  // editingField tracks which of the three is mid-edit so the shared
  // handlers below know where a keystroke or blur applies; fieldText is
  // deliberately blank on focus rather than pre-filled with the current
  // value, so typing starts fresh instead of appending after it.
  const [editingField, setEditingField] = useState(null)
  const [fieldText, setFieldText] = useState('')
  const FIELD_SETTERS = { hour: setHourValue, minute: setMinuteValue, second: setSecondValue }

  function startEdit(field) {
    setEditingField(field)
    setFieldText('')
  }
  function handleFieldChange(e) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 2)
    setFieldText(digits)
    if (digits.length === 2) {
      FIELD_SETTERS[editingField](Number(digits))
      setEditingField(null)
      setFieldText('')
    }
  }
  function commitField() {
    if (editingField && fieldText !== '') FIELD_SETTERS[editingField](Number(fieldText))
    setEditingField(null)
    setFieldText('')
  }

  const spinCol = (field, label, display, onUp, onDown) => (
    <div className="dt-picker-spin-col">
      <button type="button" className="dt-picker-spin-btn" aria-label={`Increase ${label}`} onClick={onUp}><ChevronUp size={14} /></button>
      <input
        type="text" inputMode="numeric" className="dt-picker-spin-value" aria-label={label}
        value={editingField === field ? fieldText : display}
        onFocus={() => startEdit(field)} onChange={handleFieldChange} onBlur={commitField}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
      />
      <button type="button" className="dt-picker-spin-btn" aria-label={`Decrease ${label}`} onClick={onDown}><ChevronDown size={14} /></button>
    </div>
  )

  return (
    <div className="dt-picker" ref={ref}>
      <div className="dt-picker-trigger">
        <input
          type="text" readOnly inputMode="none" className="dt-picker-input" placeholder="--:--:-- --"
          value={value ? formatDisplay12h(value) : ''}
          onClick={() => setOpen(true)} onFocus={() => setOpen(true)}
        />
        <button type="button" className="dt-picker-icon-btn" aria-label="Open time picker" onClick={() => setOpen((v) => !v)}>
          <Clock size={15} />
        </button>
      </div>
      {open && (
        <div className="dt-picker-popup dt-picker-popup-time">
          <div className="dt-picker-time-cols">
            {spinCol('hour', 'hour', pad(h12 ?? 12), () => bumpHour(1), () => bumpHour(-1))}
            <span className="dt-picker-spin-sep">:</span>
            {spinCol('minute', 'minute', pad(minute ?? 0), () => bumpMinute(1), () => bumpMinute(-1))}
            <span className="dt-picker-spin-sep">:</span>
            {spinCol('second', 'second', pad(second ?? 0), () => bumpSecond(1), () => bumpSecond(-1))}
            <div className="dt-picker-spin-col">
              <button type="button" className="dt-picker-spin-btn" aria-label="Toggle AM/PM" onClick={togglePeriod}><ChevronUp size={14} /></button>
              <div className="dt-picker-spin-value">{period ?? 'AM'}</div>
              <button type="button" className="dt-picker-spin-btn" aria-label="Toggle AM/PM" onClick={togglePeriod}><ChevronDown size={14} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
