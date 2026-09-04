'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { TrendingUp, Settings, Moon, Sun, ChevronDown, ChevronUp } from 'lucide-react'
import { strategyColor } from '@/lib/strategyColor'
import { useStickyTopbar } from '@/lib/useStickyTopbar'
import InstrumentNav from '@/components/InstrumentNav'

// Shell for the two pages with no single instrument in view - the
// cross-instrument Dashboard and the all-instruments Trades page. Mirrors
// [instrument]/layout.js's shell (topbar + sidebar) but the sidebar
// aggregates strategies across every instrument instead of one, and has no
// "Add new" strategy option (that only makes sense scoped to one
// instrument). No Insights link either - its real feature is still
// unbuilt, see app/app/[instrument]/insights/page.js.
export default function AppShell({ instruments, strategies = [], active, hideSidebar = false, anchorTopbar = false, children }) {
  const [theme, setTheme] = useState('dark')
  const [strategiesExpanded, setStrategiesExpanded] = useState(true)
  const { topbarRef, mode: topbarMode, spacerStyle } = useStickyTopbar({ anchored: anchorTopbar })

  useEffect(() => {
    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
    setTheme(storedTheme || 'dark')
    if (window.innerWidth <= 900) setStrategiesExpanded(false)
  }, [])

  function handleThemeToggle() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    const root = document.documentElement
    // Suppresses every element's own transition (mostly meant for hover,
    // not this) for exactly one theme switch - see the .theme-switching
    // comment in globals.css for why that's needed. Double rAF so the
    // no-transition switch has actually painted before transitions come
    // back, rather than racing the removal against the switch itself.
    root.classList.add('theme-switching')
    setTheme(newTheme)
    localStorage.setItem('edgelog-theme', newTheme)
    root.setAttribute('data-theme', newTheme)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove('theme-switching'))
    })
  }

  const instrumentById = {}
  instruments.forEach((inst, i) => { instrumentById[inst.id] = { ...inst, color: strategyColor(i) } })

  // Grouped by instrument (in the same order the topbar's instrument pills
  // use), then alphabetically by name within each instrument - the flat
  // creation-date order this list otherwise inherits from the API mixes
  // every instrument's strategies together with no way to tell at a
  // glance which belong to which.
  const instrumentOrder = {}
  instruments.forEach((inst, i) => { instrumentOrder[inst.id] = i })
  const sortedStrategies = strategies.slice().sort((a, b) => {
    const order = (instrumentOrder[a.instrument_id] ?? 0) - (instrumentOrder[b.instrument_id] ?? 0)
    return order !== 0 ? order : a.name.localeCompare(b.name)
  })

  return (
    <div className="shell">
      <header ref={topbarRef} className={`shell-topbar${topbarMode === 'hidden' ? ' topbar-hidden' : ''}${topbarMode === 'pinned' ? ' topbar-pinned' : ''}${anchorTopbar ? ' topbar-anchored' : ''}`}>
        <Link href="/app" className="shell-logo"><TrendingUp size={18} />Edge<span>Log</span></Link>
        <InstrumentNav instruments={instruments} />
        <div className="shell-topbar-right">
          <button type="button" className="icon-btn theme-toggle-btn" onClick={handleThemeToggle} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
          <Link href="/app/account" className="icon-btn" title="Account Settings"><Settings size={19} /></Link>
        </div>
      </header>
      <div className="topbar-spacer" style={spacerStyle} />

      <div className="shell-body">
        {!hideSidebar && (
          <aside className="sidebar">
            <Link href="/app" className={`sidebar-item ${active === 'overview' ? 'sidebar-item-active' : ''}`}>
              Overview
            </Link>

            <div className="sidebar-section-header" onClick={() => setStrategiesExpanded(!strategiesExpanded)}>
              <span>Strategies</span>
              {strategiesExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </div>
            {strategiesExpanded && (
              <div className="sidebar-substrategies">
                {strategies.length === 0 && (
                  <div className="sidebar-substrategy-empty">No strategies yet</div>
                )}
                {sortedStrategies.map((s) => {
                  const inst = instrumentById[s.instrument_id]
                  return (
                    <Link key={s.id} href={`/app/${inst?.symbol}/strategies/${s.id}`} className="sidebar-substrategy">
                      <span className="strategy-dot" style={{ background: inst?.color }} />
                      {s.name}
                      {inst && <span className="sidebar-substrategy-tag">{inst.symbol}</span>}
                    </Link>
                  )
                })}
              </div>
            )}

            <Link href="/app/log" className={`sidebar-item ${active === 'trades' ? 'sidebar-item-active' : ''}`}>
              Trade Log
            </Link>
          </aside>
        )}

        <main className="main-area">{children}</main>
      </div>
    </div>
  )
}
