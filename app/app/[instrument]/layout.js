'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  LayoutGrid, TrendingUp, List, Calendar, Lightbulb,
  Settings, User, ChevronDown, ChevronUp, Plus,
} from 'lucide-react'
import { supabase } from '../../../lib/supabaseClient'
import { strategyColor } from '../../../lib/strategyColor'

export default function InstrumentLayout({ children, params }) {
  const router = useRouter()
  const pathname = usePathname()
  const currentSymbol = params.instrument

  const [instruments, setInstruments] = useState([])
  const [strategies, setStrategies] = useState([])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [strategiesExpanded, setStrategiesExpanded] = useState(true)
  const [addingInstrument, setAddingInstrument] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')

  useEffect(() => {
    if (window.innerWidth <= 900) setStrategiesExpanded(false)
  }, [])

  useEffect(() => {
    loadData()
  }, [currentSymbol])

  async function loadData() {
    const { data: { user } } = await supabase.auth.getUser()
    const { data: instrumentData } = await supabase
      .from('instruments')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
    setInstruments(instrumentData || [])

    const current = (instrumentData || []).find((i) => i.symbol === currentSymbol)
    if (current) {
      const { data: stratData } = await supabase
        .from('strategies')
        .select('*')
        .eq('instrument_id', current.id)
        .eq('archived', false)
        .order('created_at', { ascending: true })
      setStrategies(stratData || [])
    }
  }

  async function handleAddInstrument(e) {
    e.preventDefault()
    const { data: { user } } = await supabase.auth.getUser()
    const clean = newSymbol.trim().toUpperCase()
    const { error } = await supabase.from('instruments').insert([{ user_id: user.id, symbol: clean }])
    if (!error) {
      setNewSymbol('')
      setAddingInstrument(false)
      router.push(`/app/${clean}/dashboard`)
    }
  }

  const isActive = (href) => pathname === href

  return (
    <div className="shell">
      <header className="shell-topbar">
        <div className="shell-logo">Edge<span>Log</span></div>

        <div className="instrument-switcher">
          <button className="instrument-btn" onClick={() => setSwitcherOpen(!switcherOpen)}>
            {currentSymbol} <ChevronDown size={14} />
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
                  <input autoFocus type="text" placeholder="e.g. ES" value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} />
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

        <a href={`/app/${currentSymbol}/log/new`} className="new-trade-btn">
          <Plus size={16} /> Log new trade
        </a>

        <div className="shell-topbar-right">
          <a href="/app/account" className="icon-btn" title="Settings"><Settings size={19} /></a>
          <a href="/app/account" className="icon-btn icon-btn-profile" title="Account"><User size={17} /></a>
        </div>
      </header>

      <div className="shell-body">
        <aside className="sidebar">
          <a href={`/app/${currentSymbol}/dashboard`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/dashboard`) ? 'sidebar-item-active' : ''}`}>
            <LayoutGrid size={17} /> Overview
          </a>

          <div className="sidebar-section-header" onClick={() => setStrategiesExpanded(!strategiesExpanded)}>
            <span><TrendingUp size={17} /> Strategies</span>
            {strategiesExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </div>
          {strategiesExpanded && (
            <div className="sidebar-substrategies">
              {strategies.map((s, i) => (
                <a
                  key={s.id}
                  href={`/app/${currentSymbol}/strategies/${s.id}`}
                  className="sidebar-substrategy"
                >
                  <span className="strategy-dot" style={{ background: strategyColor(i) }} />
                  {s.name}
                </a>
              ))}
            </div>
          )}

          <a href={`/app/${currentSymbol}/log`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/log`) ? 'sidebar-item-active' : ''}`}>
            <List size={17} /> Trades
          </a>
          <a href={`/app/${currentSymbol}/calendar`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/calendar`) ? 'sidebar-item-active' : ''}`}>
            <Calendar size={17} /> Calendar
          </a>
          <a href={`/app/${currentSymbol}/insights`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/insights`) ? 'sidebar-item-active' : ''}`}>
            <Lightbulb size={17} /> Insights
          </a>
        </aside>

        <main className="main-area">{children}</main>
      </div>
    </div>
  )
}
