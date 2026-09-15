'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { UNCLASSIFIED } from '@/lib/tradeQuery'

// The trade log's filters, as a bottom sheet.
//
// The desktop puts these in the table's own column headers - a chevron
// per column, opening a menu positioned against that header. That is a
// good desktop pattern and an impossible mobile one: there are no column
// headers left to hang them off, and a popup anchored to a 40px-wide cell
// on a 390px screen has nowhere to go.
//
// A sheet is the phone convention instead, and it has a real advantage
// here beyond convention: every dimension is visible at once, so a trader
// can see that they have a day AND a strategy AND a result filter active
// rather than discovering the third one by reopening three menus.
//
// Applied live rather than behind an "Apply" button. The count in the
// toolbar updates as each is tapped, so the effect is visible without
// committing, and there is no draft state to lose by swiping the sheet
// away.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DIRECTIONS = [
  { value: 'all', label: 'All' },
  { value: 'long', label: 'Long' },
  { value: 'short', label: 'Short' },
]
const RESULTS = [
  { value: 'all', label: 'All' },
  { value: 'win', label: 'Win' },
  { value: 'loss', label: 'Loss' },
  { value: 'breakeven', label: 'Breakeven' },
]

// How many dimensions are narrowed, not how many values are ticked.
// "Mon, Tue, Wed" is one decision the trader made about days, and showing
// 3 on the badge would suggest three separate constraints to go and undo.
export function countActiveFilters(filters) {
  if (!filters) return 0
  let n = 0
  if (filters.days?.length) n++
  if (filters.strategyKeys?.length) n++
  if (filters.tags?.length) n++
  if (filters.direction && filters.direction !== 'all') n++
  if (filters.result && filters.result !== 'all') n++
  return n
}

function toggle(list, value) {
  const set = new Set(list || [])
  if (set.has(value)) set.delete(value)
  else set.add(value)
  return [...set]
}

export default function MobileFilterSheet({
  open,
  onClose,
  filters,
  onFilterChange,
  strategies = [],
  tagOptions = [],
}) {
  // A sheet over a scrolling list has to stop the list scrolling
  // underneath it, or dragging inside the sheet scrolls the page behind
  // and the sheet appears to slide away under the thumb.
  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Escape closes it. Phones have no Escape key, but this also runs on a
  // 768px-wide tablet with a keyboard attached, and the cost is four
  // lines.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const active = countActiveFilters(filters)

  return (
    <div className="m-sheet-backdrop" onClick={onClose}>
      {/* The sheet swallows clicks so tapping inside it doesn't close it,
          while the backdrop above still does. */}
      <div
        className="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Filter trades"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="m-sheet-grab" aria-hidden="true" />

        <div className="m-sheet-head">
          <h2>Filter</h2>
          <div className="m-sheet-head-actions">
            {active > 0 ? (
              <button
                type="button"
                className="m-sheet-clear"
                onClick={() => onFilterChange({ days: [], strategyKeys: [], direction: 'all', result: 'all', tags: [] })}
              >
                Clear all
              </button>
            ) : null}
            <button type="button" className="m-sheet-close" onClick={onClose} aria-label="Close filters">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="m-sheet-body">
          <section className="m-filter-group">
            <h3>Direction</h3>
            <div className="m-seg">
              {DIRECTIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  className={`m-seg-item${filters.direction === d.value ? ' is-active' : ''}`}
                  onClick={() => onFilterChange({ direction: d.value })}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </section>

          <section className="m-filter-group">
            <h3>Result</h3>
            <div className="m-seg">
              {RESULTS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  className={`m-seg-item${filters.result === r.value ? ' is-active' : ''}`}
                  onClick={() => onFilterChange({ result: r.value })}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </section>

          {strategies.length ? (
            <section className="m-filter-group">
              <h3>Strategy</h3>
              <div className="m-chips">
                {strategies.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`m-chip${filters.strategyKeys?.includes(s.id) ? ' is-active' : ''}`}
                    onClick={() => onFilterChange({ strategyKeys: toggle(filters.strategyKeys, s.id) })}
                  >
                    {s.name}
                  </button>
                ))}
                {/* Unassigned is a real, filterable bucket, not a gap in
                    the list: lib/tradeQuery's applyStrategyFilter takes
                    this sentinel alongside real ids, and the desktop
                    table has always offered it. Without it a trader
                    cannot find the trades the dashboard keeps telling
                    them are "not counted until reassigned". */}
                <button
                  type="button"
                  className={`m-chip${filters.strategyKeys?.includes(UNCLASSIFIED) ? ' is-active' : ''}`}
                  onClick={() => onFilterChange({ strategyKeys: toggle(filters.strategyKeys, UNCLASSIFIED) })}
                >
                  Unassigned
                </button>
              </div>
            </section>
          ) : null}

          <section className="m-filter-group">
            <h3>Day of week</h3>
            <div className="m-chips">
              {DAY_NAMES.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  className={`m-chip${filters.days?.includes(i) ? ' is-active' : ''}`}
                  onClick={() => onFilterChange({ days: toggle(filters.days, i) })}
                >
                  {name.slice(0, 3)}
                </button>
              ))}
            </div>
          </section>

          {tagOptions.length ? (
            <section className="m-filter-group">
              <h3>Tags</h3>
              <div className="m-chips">
                {tagOptions.map((t) => {
                  const value = typeof t === 'string' ? t : t.value
                  const label = typeof t === 'string' ? t : (t.label || t.value)
                  return (
                    <button
                      key={value}
                      type="button"
                      className={`m-chip${filters.tags?.includes(value) ? ' is-active' : ''}`}
                      onClick={() => onFilterChange({ tags: toggle(filters.tags, value) })}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </section>
          ) : null}
        </div>

        <div className="m-sheet-foot">
          <button type="button" className="m-sheet-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
