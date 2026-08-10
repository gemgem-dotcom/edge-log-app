'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LayoutGrid, Layers, Settings, Moon, Sun, ChevronDown, ChevronUp } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { INSTRUMENT_CATALOG, catalogEntryFor } from '@/lib/instrumentCatalog'
import { strategyColor } from '@/lib/strategyColor'
import PageLoading from '@/components/PageLoading'
import OverviewDashboard from '@/components/OverviewDashboard'

export default function AppHome() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [instruments, setInstruments] = useState([])
  const [theme, setTheme] = useState('dark')
  const [instrumentsExpanded, setInstrumentsExpanded] = useState(true)

  // Onboarding step - a user with zero instruments always lands here, which
  // also happens if an existing user later deletes all of theirs, not just
  // on first signup. The name step is only for someone who has genuinely
  // never set one, so it's decided from user_metadata in loadInstruments()
  // rather than always shown first.
  const [step, setStep] = useState('setup')
  const [fullName, setFullName] = useState('')
  const [savingName, setSavingName] = useState(false)

  // Onboarding form state
  const [symbol, setSymbol] = useState('')
  const [strategyName, setStrategyName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadInstruments()
    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
    setTheme(storedTheme || 'dark')
    if (window.innerWidth <= 900) setInstrumentsExpanded(false)
  }, [])

  function handleThemeToggle() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    localStorage.setItem('edgelog-theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  async function loadInstruments() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    setInstruments(data || [])
    if (!error && data && data.length > 0) {
      setLoading(false)
      return
    }
    setStep(user.user_metadata?.full_name ? 'setup' : 'name')
    setLoading(false)
  }

  async function handleNameSubmit(e) {
    e.preventDefault()
    setSavingName(true)
    await supabase.auth.updateUser({ data: { full_name: fullName.trim() } })
    setSavingName(false)
    setStep('setup')
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

  if (instruments.length > 0) {
    return (
      <div className="shell">
        <header className="shell-topbar">
          <div className="shell-logo">Edge<span>Log</span></div>
          <div className="shell-topbar-right">
            <button type="button" className="icon-btn theme-toggle-btn" onClick={handleThemeToggle} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              {theme === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
            </button>
            <a href="/app/account" className="icon-btn" title="Account Settings"><Settings size={19} /></a>
          </div>
        </header>

        <div className="shell-body">
          <aside className="sidebar">
            <a href="/app" className="sidebar-item sidebar-item-active"><LayoutGrid size={17} /> Overview</a>

            <div className="sidebar-section-header" onClick={() => setInstrumentsExpanded(!instrumentsExpanded)}>
              <span><Layers size={17} /> Instruments</span>
              {instrumentsExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </div>
            {instrumentsExpanded && (
              <div className="sidebar-substrategies">
                {instruments.map((inst, i) => (
                  <a key={inst.id} href={`/app/${inst.symbol}/dashboard`} className="sidebar-substrategy">
                    <span className="strategy-dot" style={{ background: strategyColor(i) }} />
                    {inst.symbol}
                  </a>
                ))}
              </div>
            )}
          </aside>

          <main className="main-area">
            <OverviewDashboard instruments={instruments} />
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="title">Edge<span style={{ fontWeight: 400 }}>Log</span></div>
        {step === 'name' ? (
          <>
            <h1>Welcome</h1>
            <p className="onboard-note">
              What should we call you? You can change this anytime in your account settings.
            </p>
            <form onSubmit={handleNameSubmit}>
              <div className="field full">
                <label>Your name</label>
                <input
                  type="text"
                  placeholder="e.g. Alex"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
              <button type="submit" disabled={savingName} className="auth-submit">
                {savingName ? 'Saving…' : 'Continue'}
              </button>
            </form>
          </>
        ) : (
          <>
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
                  placeholder="e.g. Powell 10AM"
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
          </>
        )}
      </div>
    </div>
  )
}
