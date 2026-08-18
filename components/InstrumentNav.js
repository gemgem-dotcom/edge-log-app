'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { INSTRUMENT_CATALOG } from '@/lib/instrumentCatalog'
import { addOrRestoreInstrument } from '@/lib/instruments'
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
  // own position:relative + top/left - same treatment as ColumnFilter's
  // menu, so it can't be clipped by any scrollable ancestor regardless of
  // where this trigger ends up sitting in the layout. Closes on
  // scroll/resize since a fixed position can't track the trigger once the
  // page moves.
  useEffect(() => {
    if (!adding) return
    const dismiss = () => close()
    // Width, unlike height, doesn't change when a mobile on-screen
    // keyboard or native <select> picker opens - only for an actual
    // orientation change or window resize, which should still dismiss
    // this. Same guard as TradeForm's tag-suggestions dropdown.
    const initialWidth = window.innerWidth
    const dismissOnResize = () => {
      if (window.innerWidth !== initialWidth) dismiss()
    }
    // Deferred a frame: the dropdown mounting right at the edge of the
    // viewport can itself trigger a scroll-into-view (and the resulting
    // layout settling can fire a stray resize), which would otherwise be
    // seen as "the user scrolled/resized" and close the dropdown before
    // they ever saw it - same reasoning as TradeForm's tag-suggestions.
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', dismiss, true)
      window.addEventListener('resize', dismissOnResize)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismissOnResize)
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
    const { error } = await addOrRestoreInstrument(user.id, newSymbol)
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
      {/* Scrollable on mobile (see globals.css) - "Add instrument" is
          deliberately NOT inside this wrapper. Five different attempts to
          keep it tappable while living inside this horizontally-scrollable
          strip (a movement-threshold check on pointer events, then
          touch-action:none, then a scroll-dismiss guard, then handling the
          tap directly off touchend) each addressed a real, verified
          mechanism and each still failed identically on a real phone -
          strong enough a pattern to conclude something about being a
          descendant of an overflow-x:auto row is unreliable here in a way
          that isn't fully diagnosable without the device itself. Keeping
          the trigger outside the scrollable region (as a flex-shrink:0
          sibling) is the one version that's actually been confirmed
          working, so it stays that way; see .instrument-nav-add-wrap in
          globals.css for how it's styled to still read as part of the row
          despite the structural separation. */}
      <div className="instrument-nav-scroll">
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
      </div>
      <div className="instrument-nav-add-wrap" ref={addRef}>
        <span ref={triggerRef} className="instrument-nav-add" onClick={handleTrigger}>+ Add instrument</span>
        {adding && pos && (
          <div className="instrument-dropdown" style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
            <form onSubmit={handleAddInstrument} className="instrument-add-form">
              {/* Not autoFocus: on a real phone, programmatically focusing a
                  <select> can open the OS's native picker (and scroll it
                  into view) immediately on mount, before the user ever
                  sees this dropdown - same class of bug the RAF deferral
                  above guards against, avoided here at the source instead. */}
              <select value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} required>
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
