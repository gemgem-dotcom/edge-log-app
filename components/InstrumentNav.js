'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { INSTRUMENT_CATALOG, catalogEntryFor } from '@/lib/instrumentCatalog'
import { useClickOutside } from '@/lib/useClickOutside'

const DROPDOWN_WIDTH = 220
const VIEWPORT_MARGIN = 12

// Pill-row instrument nav shown in every shell topbar: "All instruments"
// (the cross-instrument Dashboard) plus one pill per instrument, plus an
// "Add instrument" trigger that opens the same add form the old dropdown
// switcher used. currentSymbol is omitted on pages with no single
// instrument in view (the Dashboard, the all-trades page), which leaves
// "All instruments" as the active pill.
//
// Live price-change badges next to each symbol are intentionally not
// implemented yet - there's no market-data source wired up (see
// instrumentCatalog.js's data_symbol comment), and the group decided to
// ship the nav now and wire prices in once a provider is chosen.
export default function InstrumentNav({ instruments, currentSymbol }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [addError, setAddError] = useState(null)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const close = useCallback(() => { setAdding(false); setAddError(null) }, [])
  const addRef = useClickOutside(adding, close)

  // Fixed-positioned, measured from the trigger, rather than the wrapper's
  // own position:relative + top/left - .instrument-nav switches to
  // overflow-x:auto on mobile (see the CLAUDE.md gotcha on #tableWrap) which
  // would otherwise clip this the same way it clips a naively absolute menu.
  // Closes on scroll/resize since a fixed position can't track the trigger
  // once the page moves - same treatment as ColumnFilter's menu.
  useEffect(() => {
    if (!adding) return
    const dismiss = () => close()
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [adding, close])

  function handleTrigger() {
    if (adding) { close(); return }
    const rect = triggerRef.current.getBoundingClientRect()
    const left = Math.min(rect.left, window.innerWidth - DROPDOWN_WIDTH - VIEWPORT_MARGIN)
    setPos({ left: Math.max(left, VIEWPORT_MARGIN), top: rect.bottom + 6 })
    setAdding(true)
  }

  async function handleAddInstrument(e) {
    e.preventDefault()
    if (!newSymbol) return
    setAddError(null)
    const { data: { user } } = await supabase.auth.getUser()
    const catalogEntry = catalogEntryFor(newSymbol)
    const { error } = await supabase.from('instruments').insert([{
      user_id: user.id,
      symbol: newSymbol,
      data_symbol: catalogEntry?.data_symbol || newSymbol,
      display_name: catalogEntry?.display_name || null,
    }])
    if (!error) {
      const addedSymbol = newSymbol
      setNewSymbol('')
      setAdding(false)
      router.push(`/app/${addedSymbol}/dashboard`)
    } else {
      setAddError(error.message)
    }
  }

  return (
    <nav className="instrument-nav">
      <a href="/app" className={`instrument-nav-item ${!currentSymbol ? 'instrument-nav-item-active' : ''}`}>
        All instruments
      </a>
      {instruments.map((inst) => (
        <a
          key={inst.id}
          href={`/app/${inst.symbol}/dashboard`}
          className={`instrument-nav-item ${inst.symbol === currentSymbol ? 'instrument-nav-item-active' : ''}`}
        >
          {inst.symbol}
        </a>
      ))}
      <div className="instrument-nav-add-wrap" ref={addRef}>
        <span ref={triggerRef} className="instrument-nav-add" onClick={handleTrigger}>+ Add instrument</span>
        {adding && pos && (
          <div className="instrument-dropdown" style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
            <form onSubmit={handleAddInstrument} className="instrument-add-form">
              <select autoFocus value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} required>
                <option value="">Select instrument…</option>
                {INSTRUMENT_CATALOG
                  .filter((i) => !instruments.some((existing) => existing.symbol === i.symbol))
                  .map((i) => (
                    <option key={i.symbol} value={i.symbol}>{i.symbol} — {i.display_name}</option>
                  ))}
              </select>
              <button type="submit">Add</button>
              {addError && <span className="field-error">{addError}</span>}
            </form>
          </div>
        )}
      </div>
    </nav>
  )
}
