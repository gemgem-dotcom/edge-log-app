'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { getInstruments, getStrategies } from '@/lib/referenceDataCache'
import { TUTORIAL_STEPS, readTutorialState, startTutorial, completeTutorial, takeQueuedClosingScreen, cacheTutorialState, readCachedTutorialState } from '@/lib/tutorial'
import { usePageTitle } from '@/lib/usePageTitle'
import PageLoading from '@/components/PageLoading'
import AppShell from '@/components/AppShell'
import OverviewDashboard from '@/components/OverviewDashboard'
import WelcomeTransition from '@/components/WelcomeTransition'
import TutorialOverlay from '@/components/TutorialOverlay'
import TimezoneGate from '@/components/TimezoneGate'

export default function AppHome() {
  const [loading, setLoading] = useState(true)
  const [instruments, setInstruments] = useState([])
  const [strategies, setStrategies] = useState([])

  // Onboarding step - a user with zero instruments always lands here, which
  // also happens if an existing user later deletes all of theirs, not just
  // on first signup. The name and timezone steps are each only shown to
  // someone who's genuinely never set that field, so both are decided from
  // user_metadata in loadInstruments() rather than always shown first. Once
  // resolved, everything past it is just the Overview page (its own
  // zero-instrument empty state, if there's nothing to show yet) - there's
  // no separate "set up your journal" form anymore, see
  // WelcomeTransition/TutorialOverlay below.
  //
  // Timezone reuses the same TimezoneGate app/app/layout.js falls back to
  // for an existing account that predates this requirement (a route other
  // than this one, with a full_name already set) - see that file's own
  // gating condition for why it defers to this sequence instead for a
  // brand-new signup still on the name step.
  const [step, setStep] = useState('setup')
  const [fullName, setFullName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [userName, setUserName] = useState('')

  // tutorial_status defaults to 'done' (see lib/tutorial.js) - showWelcome
  // only ever goes true for a genuinely zero-instrument, never-yet-shown
  // account, computed once in loadInstruments() and never re-derived from
  // tutorial.status afterward, so a mid-fade re-render can't flicker it
  // back on.
  //
  // Seeded from the sessionStorage cache rather than the hardcoded default,
  // so a step-0 overlay that's actually still active renders on the very
  // first paint instead of popping in only once loadInstruments()'s own
  // supabase.auth.getUser() call resolves - see cacheTutorialState's own
  // comment in lib/tutorial.js.
  const [tutorial, setTutorial] = useState(readCachedTutorialState)
  const [showWelcome, setShowWelcome] = useState(false)
  const [showClosing, setShowClosing] = useState(false)

  useEffect(() => {
    loadInstruments()
  }, [])

  // Set by log/new/page.js's tutorial step-3 tap handler (queueClosingScreen)
  // right before it navigates here - the signal to show the closing screen
  // below instead of dropping the user straight onto a silent Overview
  // page. Read (and cleared) once on mount so a later refresh doesn't
  // re-show it. This used to read a ?onboarded=1 query param instead, but
  // that didn't reliably survive a real production soft-navigation to this
  // route (which is fully static) - sessionStorage sidesteps the whole
  // question of whether a fresh searchParams prop actually arrives.
  useEffect(() => {
    if (takeQueuedClosingScreen()) setShowClosing(true)
  }, [])

  async function loadInstruments() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    // Routed through the shared instruments/strategies cache
    // (referenceDataCache.js) rather than a fresh query every time - the
    // same rows [instrument]/layout.js's sidebar just fetched (or will
    // fetch) landing here right after, and re-querying from scratch was
    // the one thing standing between "any page -> All instruments" and an
    // instant transition, since this cache hit skips the network
    // round-trip entirely on a warm cache. Every write path that touches
    // either table already invalidates it (see that file's own comment),
    // so this can't go stale.
    const loadedInstruments = await getInstruments(supabase, user.id)
    setInstruments(loadedInstruments)
    setUserName(user.user_metadata?.full_name || '')

    // Read fresh on every load (not just mount) so a page refresh
    // mid-tutorial (step 0 only happens here - steps 1/2 live on the
    // per-instrument dashboard) resumes at the stored state instead of
    // restarting from Welcome.
    const t = readTutorialState(user)
    setTutorial(t)
    cacheTutorialState(t)
    setShowWelcome(loadedInstruments.length === 0 && t.status === 'pending')

    if (loadedInstruments.length > 0) {
      // Per-instrument, not one combined query - matches how the cache is
      // actually keyed (strategiesCache is a Map by instrument_id), so an
      // instrument whose strategies are already warm from a visit to its
      // own dashboard costs nothing here even when a sibling instrument
      // still needs a real fetch.
      const strategyLists = await Promise.all(loadedInstruments.map((i) => getStrategies(supabase, i.id)))
      setStrategies(strategyLists.flat())
      setLoading(false)
      return
    }
    if (!user.user_metadata?.full_name) {
      setStep('name')
    } else if (!user.user_metadata?.timezone) {
      setStep('timezone')
    } else {
      setStep('setup')
    }
    setLoading(false)
  }

  async function handleNameSubmit(e) {
    e.preventDefault()
    setSavingName(true)
    const { data: { user } } = await supabase.auth.updateUser({ data: { full_name: fullName.trim() } })
    setSavingName(false)
    setUserName(fullName.trim())
    // Straight from name into timezone (the same order loadInstruments()
    // computes on a fresh load) rather than assuming it's unset - a user
    // who somehow already has one (set once through Account Settings, full
    // name cleared some other way) shouldn't be asked again.
    setStep(user.user_metadata?.timezone ? 'setup' : 'timezone')
  }

  function handleTimezoneSet() {
    setStep('setup')
  }

  async function handleWelcomeContinue() {
    await startTutorial()
    setTutorial({ status: 'active', step: 0 })
  }

  function handleWelcomeDone() {
    setShowWelcome(false)
  }

  // Nothing to do on tap besides the fade itself - the closing screen isn't
  // advancing any state (the tutorial's already been marked done by the
  // time this page shows it), just acknowledging setup is finished before
  // revealing the Overview page underneath.
  function handleClosingContinue() {}

  function handleClosingDone() {
    setShowClosing(false)
  }

  async function handleExitTutorial() {
    await completeTutorial()
    setTutorial({ status: 'done', step: 0 })
  }

  usePageTitle(loading ? null : (step === 'name' ? 'Welcome' : step === 'timezone' ? 'Set Your Timezone' : 'Overview'))

  if (loading) {
    return <PageLoading />
  }

  if (step === 'name') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="title">Edge<span style={{ fontWeight: 400 }}>Log</span></div>
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
        </div>
      </div>
    )
  }

  if (step === 'timezone') {
    return <TimezoneGate onSet={handleTimezoneSet} />
  }

  return (
    <>
      <AppShell instruments={instruments} strategies={strategies} active="overview" hideSidebar={instruments.length === 0} anchorTopbar={tutorial.status === 'active'}>
        <OverviewDashboard instruments={instruments} strategies={strategies} />
      </AppShell>
      {showWelcome && (
        <WelcomeTransition
          title={`Welcome${userName ? `, ${userName}` : ''}`}
          subtitle="Let's get your trading journal set up."
          actionLabel="Let's get started"
          onContinue={handleWelcomeContinue}
          onDone={handleWelcomeDone}
        />
      )}
      {!showWelcome && tutorial.status === 'active' && tutorial.step === 0 && instruments.length === 0 && (
        <TutorialOverlay step={0} steps={TUTORIAL_STEPS} onExit={handleExitTutorial} />
      )}
      {showClosing && (
        <WelcomeTransition
          title="You're all set."
          subtitle="Your first instrument and strategy are ready. Start logging trades and let EdgeLog handle the rest."
          actionLabel="Take me to my dashboard"
          onContinue={handleClosingContinue}
          onDone={handleClosingDone}
        />
      )}
    </>
  )
}
