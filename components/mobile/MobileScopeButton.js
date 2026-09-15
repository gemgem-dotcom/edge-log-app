'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ChevronDown, Check, Plus, X } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { INSTRUMENT_CATALOG } from '@/lib/instrumentCatalog'
import { addOrRestoreInstrument } from '@/lib/instruments'
import { friendlyInstrumentError } from '@/lib/supabaseErrors'
import { scopeHrefFor } from '@/lib/mobileTabs'

// The mobile topbar's ONE navigation control, sitting opposite the logo.
//
// It replaces four things at once: the InstrumentNav pill row (which ate
// a whole second topbar row and reset your section on every switch), the
// header clock (the phone has one), the theme toggle (Account ->
// Preferences already has one) and the cog (the Account tab already goes
// there). What is left is a single question - whose data am I looking at -
// which is genuinely per-screen and genuinely needs a control.
//
// Scope and section are independent here: picking ES from the trade log
// lands on ES's trade log, not its dashboard. See scopeHrefFor.
//
// Renders only on mobile - the callers gate on useIsMobile - so there is
// no desktop markup to affect, and every class is `m-` prefixed with its
// rules inside the 768px media query.
function displayNameFor(symbol) {
  return INSTRUMENT_CATALOG.find((i) => i.symbol === symbol)?.display_name || ''
}

export default function MobileScopeButton({ instruments = [], currentSymbol = null }) {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [addError, setAddError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  function close() {
    setOpen(false)
    setAdding(false)
    setAddError(null)
    setNewSymbol('')
  }

  function go(symbol) {
    close()
    router.push(scopeHrefFor(pathname, symbol))
  }

  async function handleAdd(e) {
    e.preventDefault()
    if (!newSymbol || saving) return
    setSaving(true)
    setAddError(null)
    // Same session guard InstrumentNav carries: this threw inside an
    // unhandled promise once a session had expired, so "Add" silently did
    // nothing.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) {
      setSaving(false)
      setAddError('Your session has expired. Sign in again to add an instrument.')
      return
    }
    const { error } = await addOrRestoreInstrument(user.id, newSymbol)
    setSaving(false)
    if (error) {
      setAddError(friendlyInstrumentError(error))
      return
    }
    const addedSymbol = newSymbol
    close()
    // Straight to the new instrument's Overview rather than through
    // scopeHrefFor: a just-added instrument has no trades and no
    // strategies, so landing on its (empty) trade log or strategy list
    // would be a worse answer than its dashboard, which says what to do
    // next.
    router.push(`/app/${addedSymbol}/dashboard`)
  }

  const longName = currentSymbol ? displayNameFor(currentSymbol) : ''
  const unused = INSTRUMENT_CATALOG.filter((i) => !instruments.some((e) => e.symbol === i.symbol))

  return (
    <>
      <button
        type="button"
        className="m-scope-btn"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {currentSymbol ? (
          <>
            {/* The symbol is a ticker, so it takes the mono face the rest
                of the app gives figures and symbols. */}
            <span className="m-scope-sym">{currentSymbol}</span>
            {longName ? <span className="m-scope-name">{longName}</span> : null}
          </>
        ) : (
          // No ticker at this scope, so NOTHING here is monospaced -
          // "All" set in the mono face read as a symbol in its own right.
          <span className="m-scope-name m-scope-all">All instruments</span>
        )}
        <ChevronDown size={14} className="m-scope-caret" aria-hidden="true" />
      </button>

      {open ? (
        <div className="m-sheet-backdrop" onClick={close}>
          <div
            className="m-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Instrument"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-sheet-grab" aria-hidden="true" />
            <div className="m-sheet-head">
              <h2>Instrument</h2>
              <button type="button" className="m-sheet-close" onClick={close} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="m-sheet-body">
              <ul className="m-scope-list">
                <li>
                  <button type="button" className="m-scope-row" onClick={() => go(null)}>
                    <span className="m-scope-row-name">All instruments</span>
                    {currentSymbol === null ? <Check size={16} className="m-scope-check" /> : null}
                  </button>
                </li>
                {instruments.map((inst) => (
                  <li key={inst.id || inst.symbol}>
                    <button type="button" className="m-scope-row" onClick={() => go(inst.symbol)}>
                      <span className="m-scope-row-sym">{inst.symbol}</span>
                      <span className="m-scope-row-name">{displayNameFor(inst.symbol)}</span>
                      {inst.symbol === currentSymbol ? <Check size={16} className="m-scope-check" /> : null}
                    </button>
                  </li>
                ))}
              </ul>

              {/* The add form opens IN the sheet rather than in a
                  positioned dropdown. InstrumentNav's own trigger has a
                  long comment about how unreliable a fixed-position menu
                  anchored inside an overflow-x:auto row turned out to be
                  on a real phone; there is no scrollable ancestor here and
                  nothing to anchor to, so the form just replaces the list
                  in place. */}
              {adding ? (
                <form className="m-scope-add-form" onSubmit={handleAdd}>
                  <select value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} required>
                    <option value="">Select instrument…</option>
                    {unused.map((i) => (
                      <option key={i.symbol} value={i.symbol}>{i.symbol} — {i.display_name}</option>
                    ))}
                  </select>
                  <button type="submit" className="m-scope-add-submit" disabled={saving}>
                    {saving ? 'Adding…' : 'Add'}
                  </button>
                  {addError ? <span className="field-error">{addError}</span> : null}
                </form>
              ) : (
                <button type="button" className="m-scope-row m-scope-add" onClick={() => setAdding(true)}>
                  <Plus size={15} aria-hidden="true" />
                  <span className="m-scope-row-name">Add instrument</span>
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
