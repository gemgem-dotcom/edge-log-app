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
function formatDisplay(iso) {
  const parsed = parseIso(iso)
  if (!parsed) return ''
  return `${pad(parsed.day)}/${pad(parsed.month + 1)}/${parsed.year}`
}

// Reformats digits-only input as the user types, auto-inserting the two
// slashes ("14082026" -> "14/08/2026") rather than requiring them typed.
function autoSlash(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 8)
  let out = digits.slice(0, 2)
  if (digits.length > 2) out += '/' + digits.slice(2, 4)
  if (digits.length > 4) out += '/' + digits.slice(4, 8)
  return out
}

function parseTyped(text) {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > new Date(year, month, 0).getDate()) return null
  return toIso(year, month - 1, day)
}

// Replaces the native <input type="date"> - its own popup can't be
// restyled (see the color-scheme comment in globals.css), so this rebuilds
// just enough of a calendar to match the app. value/onChange/min/max all
// speak the same ISO YYYY-MM-DD string the native input used, so nothing
// downstream (validateSetup's string comparisons, the trades table) needed
// to change.
export default function DatePicker({ value, onChange, min, max }) {
  const [open, setOpen] = useState(false)
  const parsedValue = parseIso(value)
  const today = new Date()
  const [viewYear, setViewYear] = useState(parsedValue?.year ?? today.getFullYear())
  const [viewMonth, setViewMonth] = useState(parsedValue?.month ?? today.getMonth())
  const ref = useClickOutside(open, useCallback(() => setOpen(false), []))

  // Typing is tracked separately from `value` so a mid-edit keystroke
  // ("14/0") isn't clobbered by the formatted-value sync below - only
  // reformats once the field isn't actively being typed into.
  const [text, setText] = useState(formatDisplay(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setText(formatDisplay(value))
  }, [value, editing])

  function handleTextChange(e) {
    setText(autoSlash(e.target.value))
  }
  function handleFocus() {
    setEditing(true)
  }
  function handleBlur() {
    setEditing(false)
    if (text.trim() === '') { onChange(''); return }
    const iso = parseTyped(text)
    if (iso) {
      onChange(iso)
      setText(formatDisplay(iso))
    } else {
      setText(formatDisplay(value))
    }
  }

  // Keep the visible month in sync if the value changes from outside this
  // component - e.g. the edit-trade page loading an existing trade in.
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
        <input
          type="text" inputMode="numeric" className="dt-picker-input" placeholder="dd/mm/yyyy"
          value={text} onChange={handleTextChange} onFocus={handleFocus} onBlur={handleBlur}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
        />
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
