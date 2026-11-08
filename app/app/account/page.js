'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, LogOut, TrendingUp } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { UTC_OFFSETS, browserOffsetGuess } from '@/lib/timezone'
import { getInstruments } from '@/lib/referenceDataCache'
import { usePageTitle } from '@/lib/usePageTitle'
import { useStickyTopbar } from '@/lib/useStickyTopbar'
import { useIsMobile } from '@/lib/useIsMobile'
import MobileTabBar from '@/components/mobile/MobileTabBar'
import MobileAccountIndex from '@/components/mobile/MobileAccountIndex'
import MobileScopeButton from '@/components/mobile/MobileScopeButton'
import { accountSectionFor } from '@/lib/accountSections'
import ProfileSection from '@/components/account/ProfileSection'
import PreferencesSection from '@/components/account/PreferencesSection'
import PasswordSection from '@/components/account/PasswordSection'
import TwoFactorSection from '@/components/account/TwoFactorSection'
import SignInHistorySection from '@/components/account/SignInHistorySection'
import DataExportSection from '@/components/account/DataExportSection'
import DangerZoneSection from '@/components/account/DangerZoneSection'
import PageLoading from '@/components/PageLoading'
import AccountSkeleton from '@/components/AccountSkeleton'
import { displayNameOf } from '@/lib/displayName'
import { peekAccount, writeAccount } from '@/lib/accountCache'

// Loads the account data once and hands it to the sections, each of which
// owns the state for its own concern. Timezone is the exception: it lives
// here because the picker and the sign-in history both depend on it.
// useSearchParams in a Client Component on a PRERENDERED route has to sit
// under a Suspense boundary, or `next build` fails with "Missing Suspense
// boundary with useSearchParams" - and, critically, `next dev` does not,
// because dev renders routes on demand. So this would have looked fine in
// mock mode and broken CI. See node_modules/next/dist/docs/01-app/
// 03-api-reference/04-functions/use-search-params.md.
export default function AccountPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AccountPageInner />
    </Suspense>
  )
}

function AccountPageInner() {
  usePageTitle('Account Settings')
  const router = useRouter()
  // No internal scroll pane on this page (unlike the app shell's
  // .main-area) - the window itself scrolls, so omit scrollRef.
  const { topbarRef, mode: topbarMode, spacerStyle } = useStickyTopbar()
  // Which section the mobile drill-down is showing, or null for the
  // index. In the URL rather than in state so the phone's back gesture
  // returns to the index instead of leaving the page.
  const sectionKey = useSearchParams().get('section')
  const isMobile = useIsMobile()

  useEffect(() => {
    if (!isMobile) return undefined
    document.body.classList.add('m-app')
    return () => document.body.classList.remove('m-app')
  }, [isMobile])
  // Seeded from the last known state, so coming back to this tab paints
  // immediately instead of showing a skeleton for four round-trips - see
  // lib/accountCache.js. loadData() still runs and still wins.
  const [warm] = useState(peekAccount)
  const [loading, setLoading] = useState(!warm)
  const [email, setEmail] = useState(warm?.email ?? '')
  const [fullName, setFullName] = useState(warm?.fullName ?? '')
  const [theme, setTheme] = useState('dark')
  const [timezone, setTimezone] = useState(warm?.timezone ?? '0')
  const [mfaFactors, setMfaFactors] = useState(warm?.mfaFactors ?? [])
  const [loginEvents, setLoginEvents] = useState(warm?.loginEvents ?? [])
  const [hasPassword, setHasPassword] = useState(warm?.hasPassword ?? true)
  // Only for the mobile scope selector in the topbar. Read through the
  // shared reference-data cache, so arriving here from any other screen
  // costs no extra query - the app shells have already populated it.
  const [instruments, setInstruments] = useState(warm?.instruments ?? [])

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    // getSession(), not getUser(). getUser() revalidates the token against
    // the auth server - a real network round-trip - and everything read
    // from it here (email, name, identities, the saved timezone) is already
    // on the stored session. Nothing on this screen is a trust decision:
    // the routes that actually change a password, a factor or the account
    // itself each re-check server-side. app/app/page.js makes the same swap
    // for the same reason; see its comment.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) return
    setEmail(user.email)
    setFullName(displayNameOf(user))

    // A Google-only account has an identity for 'google' but none for
    // 'email', so signInWithPassword has nothing to check it against -
    // the password-confirmation flows in PasswordSection and
    // DangerZoneSection both branch on this.
    setHasPassword((user.identities || []).some((identity) => identity.provider === 'email'))

    const savedTz = user.user_metadata?.timezone
    const savedTzValue =
      savedTz !== undefined && savedTz !== null && UTC_OFFSETS.some((o) => o.value === String(savedTz))
        ? String(savedTz)
        : browserOffsetGuess()
    setTimezone(savedTzValue)

    // Theme - read from localStorage (matches the inline script in layout.js
    // that prevents a flash of the wrong theme on page load).
    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
    setTheme(storedTheme || 'dark')

    // IN PARALLEL. None of these three depends on another's result, and
    // run in series they were three round-trips of skeleton stacked end
    // to end on a screen that is mostly static text.
    const [factorsRes, instrumentList, eventsRes] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      getInstruments(supabase, user.id),
      supabase
        .from('login_events')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ])
    const factors = factorsRes?.data?.totp || []
    const events = eventsRes?.data || []
    setMfaFactors(factors)
    setInstruments(instrumentList)
    setLoginEvents(events)

    // Theme is deliberately left out: it is per-device, read from
    // localStorage above, and must not be carried between sessions here.
    writeAccount({
      email: user.email,
      fullName: displayNameOf(user),
      timezone: savedTzValue,
      mfaFactors: factors,
      loginEvents: events,
      hasPassword: (user.identities || []).some((identity) => identity.provider === 'email'),
      instruments: instrumentList,
    })

    setLoading(false)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // AccountSkeleton is the phone's index shape and falls back to these
  // same bars on desktop; the Suspense fallback above stays PageLoading,
  // since that boundary is for useSearchParams and resolves during
  // hydration, when useIsMobile has no answer yet anyway.
  if (loading) return <AccountSkeleton />

  // One <PasswordSection> etc. per key, built once so the desktop's
  // stacked list and the mobile drill-down render the SAME element rather
  // than two copies that can drift apart.
  const sectionEls = {
    profile: <ProfileSection email={email} initialFullName={fullName} />,
    preferences: (
      <PreferencesSection
        initialTheme={theme}
        timezone={timezone}
        onTimezoneChange={setTimezone}
      />
    ),
    // These three are panel-title fragments rather than whole panels -
    // on desktop they share one .panel with dividers between them, so on
    // their own they each need one.
    password: <div className="panel"><PasswordSection email={email} hasPassword={hasPassword} onPasswordSet={() => setHasPassword(true)} /></div>,
    twofactor: <div className="panel"><TwoFactorSection initialFactors={mfaFactors} /></div>,
    devices: <div className="panel"><SignInHistorySection initialEvents={loginEvents} /></div>,
    export: <DataExportSection />,
    danger: <DangerZoneSection email={email} hasPassword={hasPassword} />,
  }

  // Mobile only. Desktop never reads the param, so a ?section= link
  // opened on a laptop renders the ordinary full page rather than a
  // fragment of it.
  const section = isMobile ? accountSectionFor(sectionKey) : null
  const dedupeHeading = section?.key === 'profile' || section?.key === 'danger'

  return (
    <div className="content-fade-in">
      {/* Desktop keeps its bespoke topbar untouched. On mobile this page
          used to render its own copy of the standard chrome, which is
          where the logo drifted to 16px - the rule that shrinks it is
          scoped to `.shell`, and this bar is the one that sits outside
          `.shell`. The shared bar in app/app/layout.js serves this screen
          now, so there is nothing here to disagree with it. */}
      {!isMobile ? (
        <>
          <div ref={topbarRef} className={`account-topbar${topbarMode === 'hidden' ? ' topbar-hidden' : ''}${topbarMode === 'pinned' ? ' topbar-pinned' : ''}`}>
            <div className="account-topbar-left">
              <Link href="/app" className="shell-logo"><TrendingUp size={18} />Edge<span>Log</span></Link>
              <Link href="/app" className="back-btn">Back to dashboard</Link>
            </div>
            <button className="back-btn" onClick={handleLogout}><LogOut size={16} /> Log out</button>
          </div>
          <div className="topbar-spacer" style={spacerStyle} />
        </>
      ) : null}

      <div className="account-wrap">
        {section ? (
          <>
            {/* A real link, not history.back(): arriving straight at
                ?section=password from a bookmark has no history entry to
                go back to, and a back button that does nothing is worse
                than none. */}
            <Link href="/app/account" className="m-account-back">
              <ChevronLeft size={16} aria-hidden="true" /> Back
            </Link>
            <h1 className="page-title">{section.label}</h1>
            {/* ProfileSection and DangerZoneSection carry their own
                <div class="section-heading"> reading the same word as the
                title above, so on their own screen the label printed
                twice. The other sections' headings say something
                different ("General", "Data") and are left alone. */}
            <div className={dedupeHeading ? 'm-section-dedupe' : undefined}>
              {sectionEls[section.key]}
            </div>
          </>
        ) : isMobile ? (
          <>
            <h1 className="page-title">Account</h1>
            <p className="page-subtitle">Manage your account and preferences.</p>
            <MobileAccountIndex email={email} onLogout={handleLogout} />
          </>
        ) : (
          <>
            <h1 className="page-title">Account settings</h1>
            <p className="page-subtitle">Manage your account and preferences.</p>

            {sectionEls.profile}
            {sectionEls.preferences}

            <div className="section-heading">Security</div>
            <div className="panel">
              <PasswordSection email={email} hasPassword={hasPassword} onPasswordSet={() => setHasPassword(true)} />
              <div className="panel-divider" />
              <TwoFactorSection initialFactors={mfaFactors} />
              <div className="panel-divider" />
              <SignInHistorySection initialEvents={loginEvents} />
            </div>

            {sectionEls.export}
            {sectionEls.danger}

            <div className="account-legal">
              <div className="copyright-line">© 2026 EdgeLog</div>
            </div>
          </>
        )}
      </div>
      {/* The tab bar used to be mounted here, because this screen sits
          outside the instrument layout that rendered it everywhere else.
          It comes from app/app/layout.js now, which covers both. */}
    </div>
  )
}
