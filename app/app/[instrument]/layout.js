'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '../../../lib/supabaseClient'

export default function InstrumentLayout({ children, params }) {
  const router = useRouter()
  const pathname = usePathname()
  const currentSymbol = params.instrument

  const [instruments, setInstruments] = useState([])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [addingInstrument, setAddingInstrument] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')

  useEffect(() => {
    loadInstruments()
  }, [])

  async function loadInstruments() {
    const { data: { user } } = await supabase.auth.getUser()
    const { data } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
    setInstruments(data || [])
  }

  async function handleAddInstrument(e) {
    e.preventDefault()
    const { data: { user } } = await supabase.auth.getUser()
    const clean = newSymbol.trim().toUpperCase()
    const { error } = await supabase.from('instruments').insert([{ user_id: user.id, symbol: clean }])
    if (!error) {
      setNewSymbol('')
      setAddingInstrument(false)
      await loadInstruments()
      router.push(`/app/${clean}/dashboard`)
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const navItem = (href, label) => (
    <a href={href} className={`nav-link ${pathname === href ? 'nav-link-active' : ''}`}>
      {label}
    </a>
  )

  return (
    <div className="wrap">
      <nav className="topnav">
        <div className="topnav-left">
          <div className="title">Edge<span>Log</span></div>

          <div className="instrument-switcher">
            <button className="instrument-btn" onClick={() => setSwitcherOpen(!switcherOpen)}>
              {currentSymbol} ▾
            </button>
            {switcherOpen && (
              <div className="instrument-dropdown">
                {instruments.map((inst) => (
                  <a
                    key={inst.id}
                    href={`/app/${inst.symbol}/dashboard`}
                    className={`instrument-option ${inst.symbol === currentSymbol ? 'instrument-option-active' : ''}`}
                    onClick={() => setSwitcherOpen(false)}
                  >
                    {inst.symbol}
                  </a>
                ))}
                <div className="instrument-divider" />
                {addingInstrument ? (
                  <form onSubmit={handleAddInstrument} className="instrument-add-form">
                    <input
                      autoFocus
                      type="text"
                      placeholder="e.g. ES"
                      value={newSymbol}
                      onChange={(e) => setNewSymbol(e.target.value)}
                    />
                    <button type="submit">Add</button>
                  </form>
                ) : (
                  <div className="instrument-option instrument-add" onClick={() => setAddingInstrument(true)}>
                    + Add instrument
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="topnav-links">
          {navItem(`/app/${currentSymbol}/dashboard`, 'Dashboard')}
          {navItem(`/app/${currentSymbol}/log`, 'Log')}
          {navItem(`/app/${currentSymbol}/log/new`, '+ New trade')}
          {navItem(`/app/${currentSymbol}/strategies`, 'Strategies')}
          <a href="/app/account" className="nav-link">Account</a>
          <span className="nav-link nav-signout" onClick={handleSignOut}>Sign out</span>
        </div>
      </nav>

      {children}
    </div>
  )
}
