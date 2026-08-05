'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { useClickOutside } from '../lib/useClickOutside'

// Chevron beside a column heading that opens that column's filter. The
// heading text itself is inert — this button is the only trigger.
//
// mode 'single': value is a string, picking an option applies it and closes.
// mode 'multi':  value is an array, checkboxes stage a draft that only
//                applies on Apply. An empty array means "no filter".
export default function ColumnFilter({ options, mode, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(mode === 'multi' ? value : null)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)

  const active = mode === 'multi' ? value.length > 0 : value !== 'all'

  // Reset the staged selection each time the menu opens, so an abandoned
  // edit doesn't linger.
  useEffect(() => {
    if (open && mode === 'multi') setDraft(value)
  }, [open, mode, value])

  // The menu is fixed-positioned so the table's horizontal scroll container
  // can't clip it. That means it has to close if anything scrolls, or it
  // would float away from its column.
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

  function handleTrigger() {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current.getBoundingClientRect()
    setPos({ left: rect.left, top: rect.bottom + 6 })
    setOpen(true)
  }

  function toggleDraft(optionValue) {
    setDraft((prev) => (
      prev.includes(optionValue) ? prev.filter((v) => v !== optionValue) : [...prev, optionValue]
    ))
  }

  return (
    <span className="col-filter" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`col-filter-btn ${active ? 'col-filter-btn-active' : ''}`}
        onClick={handleTrigger}
        aria-label="Filter this column"
        aria-expanded={open}
      >
        <ChevronDown size={13} />
      </button>

      {open && pos && (
        <div className="col-filter-menu" style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
          {mode === 'single' ? (
            options.map((o) => (
              <div
                key={o.value}
                className={`col-filter-option ${value === o.value ? 'col-filter-option-selected' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false) }}
              >
                {o.label}
              </div>
            ))
          ) : (
            <>
              {options.map((o) => (
                <label key={o.value} className="col-filter-option">
                  <input
                    type="checkbox"
                    checked={draft.includes(o.value)}
                    onChange={() => toggleDraft(o.value)}
                  />
                  {o.label}
                </label>
              ))}
              <div className="col-filter-actions">
                <button type="button" onClick={() => { onChange(draft); setOpen(false) }}>Apply</button>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  )
}
