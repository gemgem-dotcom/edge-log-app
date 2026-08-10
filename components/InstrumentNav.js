'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { INSTRUMENT_CATALOG, catalogEntryFor } from '@/lib/instrumentCatalog'
import { useClickOutside } from '@/lib/useClickOutside'

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
  const addRef = useClickOutside(adding, () => { setAdding(false); setAddError(null) })

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
        <span className="instrument-nav-add" onClick={() => setAdding(!adding)}>+ Add instrument</span>
        {adding && (
          <div className="instrument-dropdown">
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
