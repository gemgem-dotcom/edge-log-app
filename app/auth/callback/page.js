'use client'

// Google sign-in redirects the browser back here once the provider has
// approved the login. This page imports the url/key from
// lib/supabaseConfig.js, never from lib/supabaseClient.js - importing a
// named export runs that whole module, so importing even just the url/key
// from supabaseClient.js would construct its shared `supabase` client too
// (detectSessionInUrl: true there by default, needed elsewhere for
// reset-password's recovery link) purely as an import side effect. That
// client's own construction-time auto-detection would then race the
// explicit exchange below for this page's one-time PKCE verifier - now
// stored in a cookie rather than localStorage (see lib/supabaseClient.js),
// same race either way - whichever consumes it first leaves the other with
// "PKCE code verifier not found in storage", even though this file never
// calls a method on that shared client itself.
//
// isSingleton: false is now load-bearing for that same isolation:
// @supabase/ssr's createBrowserClient caches and reuses ONE client per
// browser tab by default (a module-level singleton keyed on nothing but
// "are we in a browser") - without opting out here, this call would
// silently return the exact same shared client this whole comment exists
// to avoid touching, defeating the isolation below entirely. The dedicated
// client built here still shares the same cookie names/storage key, so the
// session it saves is picked up by the rest of the app immediately.
//
// The exchange itself is also guarded against running twice on the same
// page load (e.g. React effects double-firing in development) - the PKCE
// code is one-time, so a second attempt fails once the first has already
// consumed the flow state, even though the first attempt succeeded.
//
// Same reasoning applies to markTutorialPendingIfNewAccount below - it
// lives in its own lib/tutorialNewAccount.js specifically because
// lib/tutorial.js (which it's conceptually part of) has its own top-level
// import of the shared supabase client, and this page shipped once already
// with that exact regression: importing the function from lib/tutorial.js
// transitively constructed the shared client and reintroduced this same
// race, even though the function itself never touched it. Never import
// anything from lib/tutorial.js here - only from lib/tutorialNewAccount.js.
import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabaseConfig'
import { markTutorialPendingIfNewAccount, resetThemeForNewAccount } from '@/lib/tutorialNewAccount'
import { usePageTitle } from '@/lib/usePageTitle'
import PageLoading from '@/components/PageLoading'

// Deliberately no message param here - app/login/page.js shows one fixed,
// generic string for every ?error=oauth regardless of what actually failed
// (a denied consent screen, a PKCE flow-state mismatch, whatever). The
// real reason is still fully visible server-side in Supabase's own auth
// logs; forwarding it into the URL only risks surfacing an internal error
// string a trader has no way to act on - see login/page.js's own comment.
function goToLoginWithError(router) {
  router.replace('/login?error=oauth')
}

export default function AuthCallbackPage() {
  usePageTitle('Signing In')
  const router = useRouter()
  const hasRun = useRef(false)

  useEffect(() => {
    async function finish() {
      if (hasRun.current) return
      hasRun.current = true

      const client = createBrowserClient(supabaseUrl, supabaseAnonKey, {
        auth: { flowType: 'pkce', detectSessionInUrl: false },
        isSingleton: false,
      })

      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')

      // The provider can redirect straight back here with an error instead
      // of a code - e.g. the user denied the Google consent screen.
      const providerError = params.get('error_description') || params.get('error')
      if (providerError && !code) {
        goToLoginWithError(router)
        return
      }

      if (code) {
        const { data: exchangeData, error } = await client.auth.exchangeCodeForSession(code)
        if (error) {
          goToLoginWithError(router)
        } else {
          await markTutorialPendingIfNewAccount(client, exchangeData?.user)
          resetThemeForNewAccount(exchangeData?.user)
          router.replace('/app')
        }
        return
      }

      // No ?code= and no error param - this shouldn't happen from a normal
      // Google sign-in (the app always uses the PKCE code flow), but check
      // for an already-established session before giving up, in case this
      // effect is somehow running after an earlier run already succeeded.
      const { data } = await client.auth.getSession()
      if (data?.session) {
        router.replace('/app')
      } else {
        goToLoginWithError(router)
      }
    }
    finish()
  }, [router])

  return <PageLoading />
}
