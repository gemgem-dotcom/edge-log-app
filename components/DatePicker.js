'use client'

import { useState, useCallback, useEffect } from 'react'
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react'
import { useClickOutside } from '../lib/useClickOutside'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const CELL_COUNT = 42 // 6 fixed rows, so the grid's height never jumps between months.

function pad(n) { return String(n).padStart(2, '0') }
function toIso(year, month, day) { return `${year}-${pad(month + 1)}-${pad(day)}` }

function parseIso(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return { year: y, month: m - 1, day: d }
}

// dd/mm/yyyy, both for display and for what typing accepts back.
function formatDisplayDDMMYYYY(iso) {
  const parsed = parseIso(iso)
  if (!parsed) return ''
  return `${pad(parsed.day)}/${pad(parsed.month + 1)}/${parsed.year}`
}

// Reformats digits-only input as the user types, auto-inserting the two
// slashes ("14082026" -> "14/08/2026") rather than requiring them typed.
// Slashes always land at raw-digit-count 2 and 4, which is exactly where
// DATE_MASK's own slashes sit (index 2 and 5) - so this output is always
// an exact character-for-character prefix of the mask at every partial
// typing state, which is what lets the overlay below just slice the mask
// instead of needing real per-character masking.
function autoSlash(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 8)
  let out = digits.slice(0, 2)
  if (digits.length > 2) out += '/' + digits.slice(2, 4)
  if (digits.length > 4) out += '/' + digits.slice(4, 8)
  return out
}

// Clamps each segment as soon as it's fully typed, rather than accepting
// anything and only discovering it's invalid on blur (where there's no
// previously-valid value to fall back to other than blanking the field).
// Only whole, complete segments are clamped - a day of "3" mid-typing is
// left alone since it could still become "31".
function clampDigits(digits, min, max) {
  let day = digits.slice(0, 2)
  let month = digits.slice(2, 4)
  let year = digits.slice(4, 8)

  if (day.length === 2) {
    day = pad(Math.min(31, Math.max(1, Number(day))))
  }
  if (month.length === 2) {
    month = pad(Math.min(12, Math.max(1, Number(month))))
  }

  let out = day + month + year
  if (year.length === 4 && day.length === 2 && month.length === 2) {
    const minYear = min ? Number(min.slice(0, 4)) : null
    const maxYear = max ? Number(max.slice(0, 4)) : null
    let y = Number(year)
    if (minYear != null) y = Math.max(minYear, y)
    if (maxYear != null) y = Math.min(maxYear, y)
    year = String(y).padStart(4, '0')

    const dd = Math.min(Number(day), new Date(y, Number(month), 0).getDate())
    let iso = toIso(y, Number(month) - 1, dd)
    if (min && iso < min) iso = min
    if (max && iso > max) iso = max
    const p = parseIso(iso)
    day = pad(p.day)
    month = pad(p.month + 1)
    year = String(p.year).padStart(4, '0')
    out = day + month + year
  }
  return out
}

const DATE_MASK = 'dd/mm/yyyy'

function parseTypedDDMMYYYY(text) {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > new Date(year, month, 0).getDate()) return null
  return toIso(year, month - 1, day)
}

// A plain typed dd/mm/yyyy text field, the same on every platform - this
// used to be a real native input[type=date] on desktop (native segmented
// typing) with a typed fallback swapped in only below the app's mobile
// breakpoint, since real mobile browsers don't support typing into
// input[type=date] at all (tapping it opens the OS's own picker with no
// keyboard entry). That split kept producing behavior that only worked on
// one platform at a time, so both now always use this one implementation.
// Pairs with an optional calendar popup, since the native popup can't be
// restyled to match the app (see the color-scheme comment in globals.css).
// value/onChange/min/max all speak the same ISO YYYY-MM-DD string the
// native input used, so nothing downstream needed to change.
export default function DatePicker({ value, onChange, min, max }) {
  const [open, setOpen] = useState(false)
  const parsedValue = parseIso(value)
  const today = new Date()
  const [viewYear, setViewYear] = useState(parsedValue?.year ?? today.getFullYear())
  const [viewMonth, setViewMonth] = useState(parsedValue?.month ?? today.getMonth())
  const ref = useClickOutside(open, useCallback(() => setOpen(false), []))

  const [text, setText] = useState(formatDisplayDDMMYYYY(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setText(formatDisplayDDMMYYYY(value))
  }, [value, editing])

  function handleTextChange(e) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 8)
    setText(autoSlash(clampDigits(digits, min, max)))
  }
  function handleTextFocus() {
    setEditing(true)
  }
  function handleTextBlur() {
    setEditing(false)
    if (text.trim() === '') { onChange(''); return }
    const iso = parseTypedDDMMYYYY(text)
    if (iso) {
      onChange(iso)
      setText(formatDisplayDDMMYYYY(iso))
    } else {
      setText(formatDisplayDDMMYYYY(value))
    }
  }

  // Keep the visible month in sync if the value changes from outside this
  // component - typing directly into the input, or the edit-trade page
  // loading an existing trade in.
  useEffect(() => {
    const p = parseIso(value)
    if (p) { setViewYear(p.year); setViewMonth(p.month) }
  }, [value])

  // Same scroll-dismiss pattern as the tag-suggestions dropdown in this
  // form: capture:true sees the popup's own scrollbar (a native 'scroll'
  // event doesn't bubble), so it has to explicitly ignore scrolls that
  // originate inside the popup itself, or nothing in it could ever scroll.
  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    const dismissOnScroll = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      dismiss()
    }
    // On mobile, tapping the icon to open this popup blurs the typed
    // input next to it, which closes the on-screen keyboard if it was
    // open - and that shrinks-then-grows the visual viewport, firing a
    // 'resize' right as this popup opens. Width, unlike height, doesn't
    // change when a keyboard opens or closes - only on an actual
    // orientation change or window resize, which is what should still
    // dismiss it.
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

  const startWeekday = new Date(viewYear, viewMonth, 1).getDay()
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate()

  const cells = []
  for (let i = 0; i < startWeekday; i++) {
    cells.push({ day: daysInPrevMonth - startWeekday + 1 + i, inMonth: false })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true })
  }
  for (let i = cells.length; i < CELL_COUNT; i++) {
    cells.push({ day: i - startWeekday - daysInMonth + 1, inMonth: false })
  }

  function isoFor(day) { return toIso(viewYear, viewMonth, day) }
  function isDisabled(day) {
    const iso = isoFor(day)
    return (min && iso < min) || (max && iso > max)
  }
  function isSelected(day) {
    return !!parsedValue && parsedValue.year === viewYear && parsedValue.month === viewMonth && parsedValue.day === day
  }
  function isToday(day) {
    return today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11) } else { setViewMonth((m) => m - 1) }
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0) } else { setViewMonth((m) => m + 1) }
  }

  function selectDay(cell) {
    if (!cell.inMonth || isDisabled(cell.day)) return
    onChange(isoFor(cell.day))
    setOpen(false)
  }

  function goToToday() {
    const t = new Date()
    const iso = toIso(t.getFullYear(), t.getMonth(), t.getDate())
    if ((min && iso < min) || (max && iso > max)) return
    setViewYear(t.getFullYear())
    setViewMonth(t.getMonth())
    onChange(iso)
    setOpen(false)
  }

  return (
    <div className="dt-picker" ref={ref}>
      <div className="dt-picker-trigger">
        <span className="dt-picker-input-wrap">
          <input
            type="text" inputMode="numeric" className="dt-picker-input" placeholder="dd/mm/yyyy"
            value={text} onChange={handleTextChange} onFocus={handleTextFocus} onBlur={handleTextBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
          />
          {/* A native input[type=date] would keep showing "mm/yyyy" for the
              segments not yet typed - a plain placeholder can't do that,
              it's all-or-nothing. text is always an exact prefix of
              DATE_MASK (see autoSlash), so the untyped remainder can just
              be sliced off it and overlaid as a muted hint, without
              touching the input's own value or cursor. */}
          {text.length > 0 && text.length < DATE_MASK.length && (
            <span className="dt-picker-mask-hint" aria-hidden="true">
              <span className="dt-picker-mask-hint-spacer">{text}</span>
              {DATE_MASK.slice(text.length)}
            </span>
          )}
        </span>
        <button type="button" className="dt-picker-icon-btn" aria-label="Open date picker" onClick={() => setOpen((v) => !v)}>
          <Calendar size={15} />
        </button>
      </div>
      {open && (
        <div className="dt-picker-popup">
          <div className="dt-picker-nav">
            <span className="dt-picker-nav-btn" onClick={prevMonth} aria-label="Previous month"><ChevronLeft size={16} /></span>
            <span className="dt-picker-nav-label">{MONTH_NAMES[viewMonth]} {viewYear}</span>
            <span className="dt-picker-nav-btn" onClick={nextMonth} aria-label="Next month"><ChevronRight size={16} /></span>
          </div>
          <div className="dt-picker-weekdays">
            {WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}
          </div>
          <div className="dt-picker-grid">
            {cells.map((c, i) => (
              <button
                type="button"
                key={i}
                className={[
                  'dt-picker-day',
                  !c.inMonth && 'dt-picker-day-muted',
                  c.inMonth && isSelected(c.day) && 'dt-picker-day-selected',
                  c.inMonth && isDisabled(c.day) && 'dt-picker-day-disabled',
                  c.inMonth && !isSelected(c.day) && isToday(c.day) && 'dt-picker-day-today',
                ].filter(Boolean).join(' ')}
                disabled={!c.inMonth || isDisabled(c.day)}
                onClick={() => selectDay(c)}
              >
                {c.day}
              </button>
            ))}
          </div>
          <div className="dt-picker-footer">
            <span className="dt-picker-today-link" onClick={goToToday}>Today</span>
          </div>
        </div>
      )}
    </div>
  )
}
