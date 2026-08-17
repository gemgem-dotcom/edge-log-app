'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useClickOutside } from '@/lib/useClickOutside'

const BUBBLE_WIDTH = 220
const VIEWPORT_MARGIN = 12

// Same "?" tooltip as FieldTooltip, but fixed-positioned and measured from
// the trigger rather than FieldTooltip's plain position:absolute bubble -
// a table header's .table-scroll wrapper has overflow-x:auto (needed so a
// wide table can scroll on narrow viewports), which clips an absolutely
// positioned bubble the same way #tableWrap clips ColumnFilter's menu (see
// the CLAUDE.md gotcha). Opens on hover for pointer devices, click for
// touch (hover never fires there), closes on scroll/resize since a fixed
// position can't track the trigger once the page moves - same treatment
// as ColumnFilter's menu.
export default function TableHeaderTooltip({ text }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(open, close)

  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  function measure() {
    const rect = btnRef.current.getBoundingClientRect()
    const centerLeft = rect.left + rect.width / 2
    const left = Math.min(
      Math.max(centerLeft, BUBBLE_WIDTH / 2 + VIEWPORT_MARGIN),
      window.innerWidth - BUBBLE_WIDTH / 2 - VIEWPORT_MARGIN
    )
    setPos({ left, top: rect.bottom + 7 })
  }

  function handleEnter() {
    measure()
    setOpen(true)
  }

  function handleClick() {
    if (open) { close(); return }
    measure()
    setOpen(true)
  }

  return (
    <span className="field-tooltip" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="field-tooltip-btn"
        aria-label="What this column means"
        aria-expanded={open}
        onMouseEnter={handleEnter}
        onMouseLeave={close}
        onClick={handleClick}
      >
        <span className="field-tooltip-glyph" aria-hidden="true">
          <svg viewBox="0 0 14 14">
            <text x="7" y="7.3" textAnchor="middle" dominantBaseline="central">?</text>
          </svg>
        </span>
      </button>
      {open && pos && (
        <span
          className="field-tooltip-bubble field-tooltip-bubble-fixed field-tooltip-bubble-open"
          role="tooltip"
          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
          onMouseEnter={handleEnter}
          onMouseLeave={close}
        >
          {text}
        </span>
      )}
    </span>
  )
}
