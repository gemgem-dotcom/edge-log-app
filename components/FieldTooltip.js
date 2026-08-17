'use client'

import { useState, useCallback } from 'react'
import { useClickOutside } from '../lib/useClickOutside'

// Small "?" next to a field label. Opens on hover for pointers and on click
// for touch, where hover never fires.
export default function FieldTooltip({ text }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(open, useCallback(() => setOpen(false), []))

  return (
    <span className="field-tooltip" ref={ref}>
      <button
        type="button"
        className="field-tooltip-btn"
        aria-label="What this field means"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="field-tooltip-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12" y2="17.01" />
          </svg>
        </span>
      </button>
      <span className={`field-tooltip-bubble ${open ? 'field-tooltip-bubble-open' : ''}`} role="tooltip">
        {text}
      </span>
    </span>
  )
}
