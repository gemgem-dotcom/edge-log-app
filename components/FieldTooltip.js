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
          <svg viewBox="0 0 14 14">
            <text x="7" y="7.3" textAnchor="middle" dominantBaseline="central">?</text>
          </svg>
        </span>
      </button>
      <span className={`field-tooltip-bubble ${open ? 'field-tooltip-bubble-open' : ''}`} role="tooltip">
        {text}
      </span>
    </span>
  )
}
