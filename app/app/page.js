'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabaseClient'

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
    const cleanSymbol = symbol.trim().toUpperCase()

    const { data: instrument, error: instrError } = await supabase
      .from('instruments')
      .insert([{ user_id: user.id, symbol: cleanSymbol }])
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

    router.replace(`/app/${cleanSymbol}/dashboard`)
  }

  if (loading) {
    return <div className="page-loading">Loading…</div>
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="title"><img src="/edgelog-logo.png" alt="EdgeLog" /></div>
        <h1>Set up your journal</h1>
        <p className="onboard-note">
          Add the first instrument you trade, and the first strategy you want to track under it.
          You can add more of both later.
        </p>
        <form onSubmit={handleOnboard}>
          <div className="field full">
            <label>Instrument</label>
            <input
              type="text"
              placeholder="e.g. NQ"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              required
            />
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
