'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { INSTRUMENT_CATALOG, catalogEntryFor } from '@/lib/instrumentCatalog'
import { useClickOutside } from '@/lib/useClickOutside'

const DROPDOWN_WIDTH = 220
const VIEWPORT_MARGIN = 12
// How far (px) a pointer can drift between down and up before this stops
// counting as a tap on the trigger and starts counting as the start of a
// horizontal scroll instead - see the pointer handlers below.
const TAP_MOVE_THRESHOLD = 10

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
  const pointerStart = useRef(null)
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

  // The trigger lives inside .instrument-nav-scroll (overflow-x:auto on
  // mobile - see globals.css), so a plain onClick isn't reliable: a real
  // finger's inevitable few px of jitter during a tap gets read by the
  // browser as the start of a pan across a scrollable strip, which
  // silently cancels the click - the button flashes its pressed state and
  // then does nothing. Tracking the pointer's own start/end position and
  // only firing on a genuinely small movement (rather than trusting the
  // browser's own, stricter tap-vs-scroll call) sidesteps that; it also
  // covers mouse clicks fine, since those never move between down and up.
  function handlePointerDown(e) {
    pointerStart.current = { x: e.clientX, y: e.clientY }
  }
  function handlePointerUp(e) {
    const start = pointerStart.current
    pointerStart.current = null
    if (!start) return
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
    if (moved < TAP_MOVE_THRESHOLD) handleTrigger()
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
      {/* Scrollable on mobile (see globals.css) - "Add instrument" is the
          last item in this same strip, so it scrolls with the instrument
          pills instead of sitting apart from them as a separately-pinned
          element. See the pointer handlers above for how it stays tappable
          despite living inside a horizontally-scrollable container. */}
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
        <div className="instrument-nav-add-wrap" ref={addRef}>
          <span
            ref={triggerRef}
            className="instrument-nav-add"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
          >
            + Add instrument
          </span>
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
      </div>
    </nav>
  )
}
