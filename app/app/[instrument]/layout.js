'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
    TrendingUp,
Settings, User, ChevronDown, ChevronUp, Plus, Moon, Sun,
} from 'lucide-react'
    import { supabase } from '@/lib/supabaseClient'
import { strategyColor } from '@/lib/strategyColor'
import { useStickyTopbar } from '@/lib/useStickyTopbar'
import InstrumentNav from '@/components/InstrumentNav'

export default function InstrumentLayout({ children, params }) {
    const router = useRouter()
    const pathname = usePathname()
    const currentSymbol = params.instrument
  const [instruments, setInstruments] = useState([])
    const [strategies, setStrategies] = useState([])
    const [currentInstrumentId, setCurrentInstrumentId] = useState(null)
    const [strategiesExpanded, setStrategiesExpanded] = useState(true)
    const [addingStrategy, setAddingStrategy] = useState(false)
    const [newStrategyName, setNewStrategyName] = useState('')
    const [strategyAddError, setStrategyAddError] = useState(null)
        const [theme, setTheme] = useState('dark')
    const { topbarRef, mode: topbarMode, spacerStyle } = useStickyTopbar()

        useEffect(() => {
                    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
                    setTheme(storedTheme || 'dark')
        }, [])

        function handleThemeToggle() {
                    const newTheme = theme === 'dark' ? 'light' : 'dark'
                    setTheme(newTheme)
                    localStorage.setItem('edgelog-theme', newTheme)
                    document.documentElement.setAttribute('data-theme', newTheme)
        }
  useEffect(() => {
        if (window.innerWidth <= 900) setStrategiesExpanded(false)
  }, [])

  // Below 900px .sidebar-substrategies becomes a floating position:absolute
  // dropdown (see globals.css) rather than inline sidebar content, so it
  // needs the same dismiss-on-scroll treatment as the app's other floating
  // menus (ColumnFilter, InstrumentNav's add-instrument dropdown) - above
  // that width it's just normal in-flow content and scrolling shouldn't
  // collapse it.
  useEffect(() => {
        if (!strategiesExpanded) return
        if (window.innerWidth > 900) return
        const dismiss = () => setStrategiesExpanded(false)
        window.addEventListener('scroll', dismiss, true)
        return () => window.removeEventListener('scroll', dismiss, true)
  }, [strategiesExpanded])

  useEffect(() => {
        loadData()
  }, [currentSymbol])

  async function loadData() {
        const { data: { user } } = await supabase.auth.getUser()

      // Security: automatically sign out after 30 days since last sign-in
                  if (user?.last_sign_in_at) {
                              const daysSinceSignIn = (Date.now() - new Date(user.last_sign_in_at).getTime()) / 86400000
                                          if (daysSinceSignIn >= 30) {
                                                        await supabase.auth.signOut({ scope: 'global' })
                                                                      router.push('/login')
                                                                                    return
                                          }
                  }
      const { data: instrumentData } = await supabase
          .from('instruments')
          .select('*')
          .eq('user_id', user.id)
          .eq('archived', false)
          .order('created_at', { ascending: true })
        setInstruments(instrumentData || [])

      const current = (instrumentData || []).find((i) => i.symbol === currentSymbol)
        if (current) {
                setCurrentInstrumentId(current.id)
                const { data: stratData } = await supabase
                  .from('strategies')
                  .select('*')
                  .eq('instrument_id', current.id)
                  .eq('archived', false)
                  .order('created_at', { ascending: true })
                setStrategies(stratData || [])
        }
  }

  async function handleAddStrategy(e) {
        e.preventDefault()
        if (!newStrategyName.trim() || !currentInstrumentId) return
        setStrategyAddError(null)
        const { data: { user } } = await supabase.auth.getUser()
        const { error } = await supabase
          .from('strategies')
          .insert([{ user_id: user.id, instrument_id: currentInstrumentId, name: newStrategyName.trim() }])
        if (!error) {
                setNewStrategyName('')
                setAddingStrategy(false)
                loadData()
        } else {
                setStrategyAddError(error.message)
        }
  }

  function cancelAddStrategy() {
        setAddingStrategy(false)
        setNewStrategyName('')
        setStrategyAddError(null)
  }

  const isActive = (href) => pathname === href

  return (
        <div className="shell">
          <header ref={topbarRef} className={`shell-topbar${topbarMode === 'hidden' ? ' topbar-hidden' : ''}${topbarMode === 'pinned' ? ' topbar-pinned' : ''}`}>
            <a href="/app" className="shell-logo"><TrendingUp size={18} />Edge<span>Log</span></a>

            <InstrumentNav instruments={instruments} currentSymbol={currentSymbol} />

        <div className="shell-topbar-right">
                              <button type="button" className="icon-btn theme-toggle-btn" onClick={handleThemeToggle} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
              </button>
                      <a href="/app/account" className="icon-btn" title="Account Settings"><Settings size={19} /></a>
            </div>
            </header>
      <div className="topbar-spacer" style={spacerStyle} />

      <div className="shell-body">
                    <aside className="sidebar">
                      <a href={`/app/${currentSymbol}/dashboard`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/dashboard`) ? 'sidebar-item-active' : ''}`}>
            Overview
            </a>

          <div className="sidebar-section-header" onClick={() => setStrategiesExpanded(!strategiesExpanded)}>
            <span>Strategies</span>
{strategiesExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
</div>
 {strategiesExpanded && (
               <div className="sidebar-substrategies">
 {strategies.map((s, i) => (
                   <a
                                   key={s.id}
                   href={`/app/${currentSymbol}/strategies/${s.id}`}
                  className={`sidebar-substrategy ${isActive(`/app/${currentSymbol}/strategies/${s.id}`) ? 'sidebar-substrategy-active' : ''}`}
                >
                                      <span className="strategy-dot" style={{ background: strategyColor(i) }} />
{s.name}
</a>
              ))}
{addingStrategy ? (
                  <>
                  <form onSubmit={handleAddStrategy} className="sidebar-strategy-add-form">
                    <input
                      autoFocus
                     type="text"
                     placeholder="Strategy name"
                     value={newStrategyName}
                     onChange={(e) => setNewStrategyName(e.target.value)}
                   />
                    <div className="sidebar-strategy-add-actions">
                      <span className="del" onClick={cancelAddStrategy}>Cancel</span>
                      <button type="submit">Add</button>
                    </div>
                       </form>
                  {strategyAddError && (
                    <span className="field-error" style={{ display: 'block', padding: '0 12px 6px 30px' }}>{strategyAddError}</span>
                  )}
                  </>
               ) : (
                                 <div className="sidebar-substrategy sidebar-strategy-add" onClick={() => setAddingStrategy(true)}>
                                   <Plus size={14} /> Add new
                 </div>
               )}
</div>
          )}

          <a href={`/app/${currentSymbol}/log`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/log`) ? 'sidebar-item-active' : ''}`}>
            Trade Log
            </a>
          <a href={`/app/${currentSymbol}/insights`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/insights`) ? 'sidebar-item-active' : ''}`}>
            Insights
            </a>
            </aside>

        <main className="main-area">{children}</main>
            </div>
            </div>
  )
}
