'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, TrendingUp } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { UTC_OFFSETS } from '@/lib/timezone'
import { usePageTitle } from '@/lib/usePageTitle'
import { useStickyTopbar } from '@/lib/useStickyTopbar'
import ProfileSection from '@/components/account/ProfileSection'
import PreferencesSection from '@/components/account/PreferencesSection'
import PasswordSection from '@/components/account/PasswordSection'
import TwoFactorSection from '@/components/account/TwoFactorSection'
import SignInHistorySection from '@/components/account/SignInHistorySection'
import DataExportSection from '@/components/account/DataExportSection'
import DangerZoneSection from '@/components/account/DangerZoneSection'
import PageLoading from '@/components/PageLoading'

// Loads the account data once and hands it to the sections, each of which
// owns the state for its own concern. Timezone is the exception: it lives
// here because the picker and the sign-in history both depend on it.
export default function AccountPage() {
  usePageTitle('Account Settings')
  const router = useRouter()
  // No internal scroll pane on this page (unlike the app shell's
  // .main-area) - the window itself scrolls, so omit scrollRef.
  const { topbarRef, mode: topbarMode, spacerStyle } = useStickyTopbar()
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [theme, setTheme] = useState('dark')
  const [timezone, setTimezone] = useState('0')
  const [mfaFactors, setMfaFactors] = useState([])
  const [loginEvents, setLoginEvents] = useState([])
  const [hasPassword, setHasPassword] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const { data: { user } } = await supabase.auth.getUser()
    setEmail(user.email)
    setFullName(user.user_metadata && user.user_metadata.full_name ? user.user_metadata.full_name : '')

    // A Google-only account has an identity for 'google' but none for
    // 'email', so signInWithPassword has nothing to check it against -
    // the password-confirmation flows in PasswordSection and
    // DangerZoneSection both branch on this.
    setHasPassword((user.identities || []).some((identity) => identity.provider === 'email'))

    const savedTz = user.user_metadata?.timezone
    if (savedTz !== undefined && savedTz !== null && UTC_OFFSETS.some((o) => o.value === String(savedTz))) {
      setTimezone(String(savedTz))
    } else {
      const browserOffset = -(new Date().getTimezoneOffset()) / 60
      const nearest = UTC_OFFSETS.reduce((best, o) =>
        Math.abs(parseFloat(o.value) - browserOffset) < Math.abs(parseFloat(best.value) - browserOffset) ? o : best
      )
      setTimezone(nearest.value)
    }

    // Theme - read from localStorage (matches the inline script in layout.js
    // that prevents a flash of the wrong theme on page load).
    const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
    setTheme(storedTheme || 'dark')

    const { data: factorsData } = await supabase.auth.mfa.listFactors()
    setMfaFactors(factorsData?.totp || [])

    const { data: events } = await supabase
      .from('login_events')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)
    setLoginEvents(events || [])

    setLoading(false)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) return <PageLoading />

  return (
    <div>
      <div ref={topbarRef} className={`account-topbar${topbarMode === 'hidden' ? ' topbar-hidden' : ''}${topbarMode === 'pinned' ? ' topbar-pinned' : ''}`}>
        <div className="account-topbar-left">
          <a href="/app" className="shell-logo"><TrendingUp size={18} />Edge<span>Log</span></a>
          <a href="/app" className="back-btn">Back to dashboard</a>
        </div>
        <button className="back-btn" onClick={handleLogout}><LogOut size={16} /> Log out</button>
      </div>
      <div className="topbar-spacer" style={spacerStyle} />

      <div className="account-wrap">
        <h1 className="page-title">ACCOUNT SETTINGS</h1>
        <p className="page-subtitle">Manage your account and preferences.</p>

        <ProfileSection email={email} initialFullName={fullName} />

        <PreferencesSection
          initialTheme={theme}
          timezone={timezone}
          onTimezoneChange={setTimezone}
        />

        <div className="section-heading">Security</div>
        <div className="panel">
          <PasswordSection email={email} hasPassword={hasPassword} />
          <div className="panel-divider" />
          <TwoFactorSection initialFactors={mfaFactors} />
          <div className="panel-divider" />
          <SignInHistorySection initialEvents={loginEvents} timezone={timezone} />
        </div>

        <DataExportSection />

        <DangerZoneSection email={email} hasPassword={hasPassword} />

        <div className="account-legal">
          <a href="/privacy?from=account">Privacy Policy</a>
          <span aria-hidden="true">·</span>
          <a href="/terms?from=account">Terms of Service</a>
        </div>
      </div>
    </div>
  )
}
