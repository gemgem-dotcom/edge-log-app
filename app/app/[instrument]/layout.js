'use client'

import { useState, useEffect, useRef, use } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import {
  TrendingUp,
  Settings, User, ChevronDown, ChevronUp, Plus, Moon, Sun,
} from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { getInstruments, getStrategies, invalidateStrategies } from '@/lib/referenceDataCache'
import { strategyColor } from '@/lib/strategyColor'
import { useStickyTopbar } from '@/lib/useStickyTopbar'
import { TUTORIAL_STEPS, readTutorialState, setTutorialStep, completeTutorial, cacheTutorialState, readCachedTutorialState } from '@/lib/tutorial'
import { friendlyStrategyError } from '@/lib/supabaseErrors'
import InstrumentNav from '@/components/InstrumentNav'
import HeaderClock from '@/components/HeaderClock'
import TutorialOverlay from '@/components/TutorialOverlay'

export default function InstrumentLayout({ children, params }) {
  const router = useRouter()
  const pathname = usePathname()
  const currentSymbol = use(params).instrument
  const [instruments, setInstruments] = useState([])
  const [strategies, setStrategies] = useState([])
  const [currentInstrumentId, setCurrentInstrumentId] = useState(null)
  const [strategiesExpanded, setStrategiesExpanded] = useState(true)
  const [addingStrategy, setAddingStrategy] = useState(false)
  const [newStrategyName, setNewStrategyName] = useState('')
  const [strategyAddError, setStrategyAddError] = useState(null)
  const [savingStrategy, setSavingStrategy] = useState(false)
  const [theme, setTheme] = useState('dark')
  // Seeded from the sessionStorage cache, not the hardcoded default - see
  // cacheTutorialState's own comment in lib/tutorial.js for why (renders
  // the correct overlay on this layout's very first paint instead of
  // waiting on loadData()'s own supabase.auth.getUser() call to resolve).
  const [tutorial, setTutorial] = useState(readCachedTutorialState)
  const { topbarRef, mode: topbarMode, spacerStyle } = useStickyTopbar({ anchored: tutorial.status === 'active' })

  useEffect(() => {
    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
    setTheme(storedTheme || 'dark')
  }, [])

  // Just flips the theme - no transition-suppression dance around it any
  // more. This used to add a .theme-switching class to <html> for one
  // frame (double rAF) to force transition:none everywhere, because the
  // surfaces that carried a hover transition faded while the ones that
  // didn't snapped. body/.panel/.stat/inputs now all transition
  // background-color at the same --transition-fast speed, so the switch
  // cross-fades on its own and there's nothing left to suppress.
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

  // Step 0's target ("+ Add instrument") lives in the topbar on
  // app/app/page.js's own zero-instrument screen, not here - reaching this
  // layout at all means an instrument now exists, so step 0 is done by
  // definition the moment this mounts mid-tutorial. addOrRestoreInstrument
  // (InstrumentNav.js) already redirects here on success, which is what
  // actually advances the tutorial in practice; this also covers the
  // two-tab race where an instrument shows up here before that redirect's
  // own page ever notices.
  useEffect(() => {
    if (tutorial.status === 'active' && tutorial.step === 0) {
      setTutorialStep(1)
      setTutorial((t) => ({ ...t, step: 1 }))
    }
  }, [tutorial.status, tutorial.step])

  // Tutorial step 1 spotlights "+ Add new" below - it has to actually be in
  // the DOM for that to find anything, so this overrides whatever the
  // mobile-collapse effect above set while that step is live.
  useEffect(() => {
    if (tutorial.status === 'active' && tutorial.step === 1) setStrategiesExpanded(true)
  }, [tutorial.status, tutorial.step])

  // Safety net for a brand-new user who already has a strategy by the time
  // step 1 loads (e.g. two tabs open, one raced ahead) - skips straight to
  // step 2 instead of spotlighting a control whose job is already done.
  useEffect(() => {
    if (tutorial.status === 'active' && tutorial.step === 1 && strategies.length > 0) {
      setTutorialStep(2)
      setTutorial((t) => ({ ...t, step: 2 }))
    }
  }, [tutorial.status, tutorial.step, strategies.length])

  // Also re-runs on every in-app navigation (pathname), not just an
  // instrument switch - deleting a strategy from its own detail page
  // redirects here via router.push, a client-side transition that leaves
  // this layout mounted, so without this its sidebar list would keep
  // showing the deleted strategy until a full page reload.
  // Identifies the most recent load, so a slower earlier one can't overwrite
  // it - see the guards inside loadData.
  const loadIdRef = useRef(0)

  useEffect(() => {
    loadData()
  }, [currentSymbol, pathname])

  async function loadData() {
    const loadId = ++loadIdRef.current
    const superseded = () => loadId !== loadIdRef.current

    // getSession(), not getUser(). This effect re-runs on every in-app
    // navigation (see its pathname dependency above), and getUser()
    // revalidates the token against the auth server - a real network round
    // trip on every single click, which is also what widened the window for
    // one navigation's results to land after the next one's. Nothing here
    // needs a server-revalidated token: it reads user.id to scope a query
    // that RLS scopes again server-side regardless, plus user_metadata,
    // which every write path refreshes on the local session anyway. Same
    // reasoning as app/app/page.js's own loadInstruments.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    // proxy.js already redirects a signed-out visitor before this page
    // ships, so this is the expired-mid-session case. Bailing quietly beats
    // throwing inside an uncaught effect promise, which left the sidebar
    // and instrument nav permanently empty with no error at all.
    if (!user) return

    // Read fresh on every load (not just mount) so a page refresh
    // mid-tutorial resumes at the stored step instead of restarting.
    const freshTutorial = readTutorialState(user)
    if (superseded()) return
    setTutorial(freshTutorial)
    cacheTutorialState(freshTutorial)

    // Security: automatically sign out after 30 days since last sign-in
    if (user?.last_sign_in_at) {
      const daysSinceSignIn = (Date.now() - new Date(user.last_sign_in_at).getTime()) / 86400000
      if (daysSinceSignIn >= 30) {
        await supabase.auth.signOut({ scope: 'global' })
        router.push('/login')
        return
      }
    }
    const instrumentData = await getInstruments(supabase, user.id)
    if (superseded()) return
    setInstruments(instrumentData)

    const current = instrumentData.find((i) => i.symbol === currentSymbol)
    if (current) {
      setCurrentInstrumentId(current.id)
      const stratData = await getStrategies(supabase, current.id)
      // Without this, switching instruments quickly could leave the sidebar
      // listing the previous instrument's strategies under the new one's
      // name - the same class of mismatch as the dashboard's own guard.
      if (superseded()) return
      setStrategies(stratData)
    }
  }

  async function handleAddStrategy(e) {
    e.preventDefault()
    // savingStrategy guards a double submit - the Add button is never
    // disabled, so pressing Enter twice fired two inserts and the second
    // tripped unique(instrument_id, name), showing "already exists" right
    // after the strategy had actually been created.
    if (!newStrategyName.trim() || !currentInstrumentId || savingStrategy) return
    setStrategyAddError(null)
    setSavingStrategy(true)
    try {
      await addStrategy()
    } finally {
      setSavingStrategy(false)
    }
  }

  async function addStrategy() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) {
      setStrategyAddError('Your session has expired. Sign in again to add a strategy.')
      return
    }
    const { error } = await supabase
      .from('strategies')
      .insert([{ user_id: user.id, instrument_id: currentInstrumentId, name: newStrategyName.trim() }])
    if (!error) {
      invalidateStrategies(currentInstrumentId)
      setNewStrategyName('')
      setAddingStrategy(false)
      if (tutorial.status === 'active' && tutorial.step === 1) {
        await setTutorialStep(2)
      }
      loadData()
    } else {
      setStrategyAddError(friendlyStrategyError(error))
    }
  }

  function cancelAddStrategy() {
    setAddingStrategy(false)
    setNewStrategyName('')
    setStrategyAddError(null)
  }

  async function handleExitTutorial() {
    await completeTutorial()
    setTutorial({ status: 'done', step: 0 })
  }

  const isActive = (href) => pathname === href

  // Alphabetical for display, but strategyColor still keys off each
  // strategy's position in the creation-date-ordered `strategies` state
  // (not its position in this sorted copy) - that index is what keeps a
  // strategy's dot the same color here and on the dashboard's strategy
  // performance table, per the comment on strategyColor itself.
  const colorIndexById = {}
  strategies.forEach((s, i) => { colorIndexById[s.id] = i })
  const sortedStrategies = strategies.slice().sort((a, b) => a.name.localeCompare(b.name))

  return (
    <>
      <div className="shell">
        <header ref={topbarRef} className={`shell-topbar${topbarMode === 'hidden' ? ' topbar-hidden' : ''}${topbarMode === 'pinned' ? ' topbar-pinned' : ''}${tutorial.status === 'active' ? ' topbar-anchored' : ''}`}>
          <Link href="/app" className="shell-logo"><TrendingUp size={18} />Edge<span>Log</span></Link>

          <InstrumentNav instruments={instruments} currentSymbol={currentSymbol} />

          <div className="shell-topbar-right">
            <HeaderClock />
            <button type="button" className="icon-btn theme-toggle-btn" onClick={handleThemeToggle} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              {theme === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
            </button>
            <Link href="/app/account" className="icon-btn" title="Account Settings"><Settings size={19} /></Link>
          </div>
        </header>
        <div className="topbar-spacer" style={spacerStyle} />

        <div className="shell-body">
          <aside className="sidebar">
            <Link href={`/app/${currentSymbol}/dashboard`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/dashboard`) ? 'sidebar-item-active' : ''}`}>
              Overview
            </Link>

            <div className="sidebar-section-header" onClick={() => setStrategiesExpanded(!strategiesExpanded)}>
              <span>Strategies</span>
              {strategiesExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </div>
            {/* Always rendered, toggled by class rather than mounted/
                unmounted - an element that unmounts has nothing left to
                animate on collapse. See .sidebar-substrategies in
                globals.css. */}
            <div className={`sidebar-substrategies ${strategiesExpanded ? 'sidebar-substrategies-open' : ''}`}>
              {sortedStrategies.map((s) => (
                <Link
                  key={s.id}
                  href={`/app/${currentSymbol}/strategies/${s.id}`}
                  className={`sidebar-substrategy ${isActive(`/app/${currentSymbol}/strategies/${s.id}`) ? 'sidebar-substrategy-active' : ''}`}
                >
                  <span className="strategy-dot" style={{ background: strategyColor(colorIndexById[s.id]) }} />
                  {s.name}
                </Link>
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
                      <button type="button" className="del" onClick={cancelAddStrategy}>Cancel</button>
                      <button type="submit">Add</button>
                    </div>
                  </form>
                  {strategyAddError && (
                    <span className="field-error" style={{ display: 'block', padding: '0 12px 6px 30px' }}>{strategyAddError}</span>
                  )}
                </>
              ) : (
                <div className="sidebar-substrategy sidebar-strategy-add" data-tutorial-target="add-strategy" onClick={() => setAddingStrategy(true)}>
                  <Plus size={14} /> Add new
                </div>
              )}
            </div>

            <Link href={`/app/${currentSymbol}/log`} className={`sidebar-item ${isActive(`/app/${currentSymbol}/log`) ? 'sidebar-item-active' : ''}`}>
              Trade Log
            </Link>
          </aside>

          <main className="main-area">{children}</main>
        </div>
      </div>
      {/* Step 1's target (the sidebar's own "+ Add new") is on every
          page under this layout, so it can render regardless of route.
          Step 2's target only exists on the dashboard page itself - once
          the tutorial has sent the user there via that button, this
          layout is still mounted on the log/new route underneath it, and
          without the pathname check below it would find nothing, fall
          back to its "target not found" full-screen block, and leave the
          trade form the tutorial just pointed at completely unusable. */}
      {tutorial.status === 'active' && tutorial.step === 1 && (
        <TutorialOverlay step={1} steps={TUTORIAL_STEPS} onExit={handleExitTutorial} />
      )}
      {tutorial.status === 'active' && tutorial.step === 2 && pathname === `/app/${currentSymbol}/dashboard` && (
        <TutorialOverlay step={2} steps={TUTORIAL_STEPS} onExit={handleExitTutorial} />
      )}
    </>
  )
}
