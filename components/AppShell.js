'use client'

import { useState, useEffect } from 'react'
import { TrendingUp, Settings, Moon, Sun, ChevronDown, ChevronUp } from 'lucide-react'
import { strategyColor } from '@/lib/strategyColor'
import InstrumentNav from '@/components/InstrumentNav'

// Shell for the two pages with no single instrument in view - the
// cross-instrument Dashboard and the all-instruments Trades page. Mirrors
// [instrument]/layout.js's shell (topbar + sidebar) but the sidebar
// aggregates strategies across every instrument instead of one, has no
// "Add new" strategy option (that only makes sense scoped to one
// instrument), and has no Insights link.
export default function AppShell({ instruments, strategies = [], active, children }) {
  const [theme, setTheme] = useState('dark')
  const [strategiesExpanded, setStrategiesExpanded] = useState(true)

  useEffect(() => {
    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
    setTheme(storedTheme || 'dark')
    if (window.innerWidth <= 900) setStrategiesExpanded(false)
  }, [])

  function handleThemeToggle() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    localStorage.setItem('edgelog-theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  const instrumentById = {}
  instruments.forEach((inst, i) => { instrumentById[inst.id] = { ...inst, color: strategyColor(i) } })

  return (
    <div className="shell">
      <header className="shell-topbar">
        <div className="shell-logo"><TrendingUp size={18} /> Edge<span>Log</span></div>
        <InstrumentNav instruments={instruments} />
        <div className="shell-topbar-right">
          <button type="button" className="icon-btn theme-toggle-btn" onClick={handleThemeToggle} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
          <a href="/app/account" className="icon-btn" title="Account Settings"><Settings size={19} /></a>
        </div>
      </header>

      <div className="shell-body">
        <aside className="sidebar">
          <a href="/app" className={`sidebar-item ${active === 'overview' ? 'sidebar-item-active' : ''}`}>
            Overview
          </a>

          <div className="sidebar-section-header" onClick={() => setStrategiesExpanded(!strategiesExpanded)}>
            <span>Strategies</span>
            {strategiesExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </div>
          {strategiesExpanded && (
            <div className="sidebar-substrategies">
              {strategies.length === 0 && (
                <div className="sidebar-substrategy-empty">No strategies yet</div>
              )}
              {strategies.map((s) => {
                const inst = instrumentById[s.instrument_id]
                return (
                  <a key={s.id} href={`/app/${inst?.symbol}/strategies/${s.id}`} className="sidebar-substrategy">
                    <span className="strategy-dot" style={{ background: inst?.color }} />
                    {s.name}
                    {inst && <span className="sidebar-substrategy-tag">{inst.symbol}</span>}
                  </a>
                )
              })}
            </div>
          )}

          <a href="/app/log" className={`sidebar-item ${active === 'trades' ? 'sidebar-item-active' : ''}`}>
            Trades
          </a>
        </aside>

        <main className="main-area">{children}</main>
      </div>
    </div>
  )
}
