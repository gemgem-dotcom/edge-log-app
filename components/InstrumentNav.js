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
  const scrollStripRef = useRef(null)
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
    // Ignores scrolls that originate from .instrument-nav-scroll itself -
    // the trigger is the last item in that strip (see the JSX below), so
    // it's exactly where a real touch tends to leave residual momentum/
    // rubber-band scrolling once the finger lifts. Without this guard,
    // that settling fires a native 'scroll' event on the strip a moment
    // after the tap that just opened this, and since this listener is on
    // window with capture:true (needed to catch scroll on any
    // non-bubbling scroll target, not just window itself), it closes the
    // dropdown within the same gesture, before it was ever visibly open -
    // indistinguishable from the tap not registering at all. This was the
    // real cause of "Add instrument" still not working after it moved
    // back inside the scrollable strip; touch-action:none on the trigger
    // (still needed, see globals.css) only ever addressed a tap being
    // swallowed as a pan gesture, not this.
    const dismissOnScroll = (e) => {
      if (e.target === scrollStripRef.current) return
      close()
    }
    // Width, unlike height, doesn't change when a mobile on-screen
    // keyboard or native <select> picker opens - only for an actual
    // orientation change or window resize, which should still dismiss
    // this. Same guard as TradeForm's tag-suggestions dropdown.
    const initialWidth = window.innerWidth
    const dismissOnResize = () => {
      if (window.innerWidth !== initialWidth) close()
    }
    // Deferred a frame: the dropdown mounting right at the edge of the
    // viewport can itself trigger a scroll-into-view (and the resulting
    // layout settling can fire a stray resize), which would otherwise be
    // seen as "the user scrolled/resized" and close the dropdown before
    // they ever saw it - same reasoning as TradeForm's tag-suggestions.
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', dismissOnScroll, true)
      window.addEventListener('resize', dismissOnResize)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', dismissOnScroll, true)
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
          element. It stays tappable despite living inside a
          horizontally-scrollable container via touch-action:none on
          .instrument-nav-add (see globals.css) - without it, the
          browser's own gesture recognizer can claim a touch that starts on
          the trigger for panning before any JS ever runs, firing
          pointercancel instead of a click/pointerup no matter how small
          the actual finger movement was. Also see scrollStripRef above -
          its own momentum/rubber-band scroll shouldn't dismiss a dropdown
          that just opened from a tap on its last item. */}
      <div className="instrument-nav-scroll" ref={scrollStripRef}>
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
