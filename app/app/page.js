'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { INSTRUMENT_CATALOG, catalogEntryFor } from '@/lib/instrumentCatalog'
import PageLoading from '@/components/PageLoading'

export default function AppHome() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [instruments, setInstruments] = useState([])

  // Onboarding form state
  const [symbol, setSymbol] = useState('')
  const [strategyName, setStrategyName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadInstruments()
  }, [])

  async function loadInstruments() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (!error && data && data.length > 0) {
      router.replace(`/app/${data[0].symbol}/dashboard`)
      return
    }
    setInstruments(data || [])
    setLoading(false)
  }

  async function handleOnboard(e) {
    e.preventDefault()
    setError('')
    setSaving(true)

    const { data: { user } } = await supabase.auth.getUser()
    const catalogEntry = catalogEntryFor(symbol)

    const { data: instrument, error: instrError } = await supabase
      .from('instruments')
      .insert([{
        user_id: user.id,
        symbol,
        data_symbol: catalogEntry?.data_symbol || symbol,
        display_name: catalogEntry?.display_name || null,
      }])
      .select()
      .single()

    if (instrError) {
      setError(instrError.message)
      setSaving(false)
      return
    }

    const { error: stratError } = await supabase
      .from('strategies')
      .insert([{ user_id: user.id, instrument_id: instrument.id, name: strategyName.trim() }])

    if (stratError) {
      setError(stratError.message)
      setSaving(false)
      return
    }

    router.replace(`/app/${symbol}/dashboard`)
  }

  if (loading) {
    return <PageLoading />
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="title">Edge<span>Log</span></div>
        <h1>Set up your journal</h1>
        <p className="onboard-note">
          Add the first instrument you trade, and the first strategy you want to track under it.
          You can add more of both later.
        </p>
        <form onSubmit={handleOnboard}>
          <div className="field full">
            <label>Instrument</label>
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} required>
              <option value="">Select instrument…</option>
              {INSTRUMENT_CATALOG.map((i) => (
                <option key={i.symbol} value={i.symbol}>{i.symbol} — {i.display_name}</option>
              ))}
            </select>
          </div>
          <div className="field full">
            <label>Your first strategy name</label>
            <input
              type="text"
              placeholder="e.g. London Sweep Reversal"
              value={strategyName}
              onChange={(e) => setStrategyName(e.target.value)}
              required
            />
          </div>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" disabled={saving} className="auth-submit">
            {saving ? 'Setting up…' : 'Start journaling'}
          </button>
        </form>
      </div>
    </div>
  )
}
