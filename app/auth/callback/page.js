'use client'

// Google sign-in redirects the browser back here once the provider has
// approved the login. This page imports the url/key from
// lib/supabaseConfig.js, never from lib/supabaseClient.js - importing a
// named export runs that whole module, so importing even just the url/key
// from supabaseClient.js would construct its shared `supabase` client too
// (detectSessionInUrl: true there by default, needed elsewhere for
// reset-password's recovery link) purely as an import side effect. That
// client's own construction-time auto-detection would then race the
// explicit exchange below for this page's one-time PKCE verifier in
// localStorage - whichever consumes it first leaves the other with
// "PKCE code verifier not found in storage", even though this file never
// calls a method on that shared client itself. The dedicated client built
// here still shares its storage key, so the session it saves is picked up
// by the rest of the app immediately.
//
// The exchange itself is also guarded against running twice on the same
// page load (e.g. React effects double-firing in development) - the PKCE
// code is one-time, so a second attempt fails once the first has already
// consumed the flow state, even though the first attempt succeeded.
import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabaseConfig'
import PageLoading from '@/components/PageLoading'

const GENERIC_OAUTH_ERROR = 'Something went wrong signing in with Google. Please try again.'

function goToLoginWithError(router, message) {
  const params = new URLSearchParams({ error: 'oauth', message: message || GENERIC_OAUTH_ERROR })
  router.replace(`/login?${params.toString()}`)
}

export default function AuthCallbackPage() {
  const router = useRouter()
  const hasRun = useRef(false)

  useEffect(() => {
    async function finish() {
      if (hasRun.current) return
      hasRun.current = true

      const client = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { flowType: 'pkce', detectSessionInUrl: false },
      })

      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')

      // The provider can redirect straight back here with an error instead
      // of a code - e.g. the user denied the Google consent screen.
      const providerError = params.get('error_description') || params.get('error')
      if (providerError && !code) {
        goToLoginWithError(router, providerError)
        return
      }

      if (code) {
        const { error } = await client.auth.exchangeCodeForSession(code)
        if (error) {
          goToLoginWithError(router, error.message)
        } else {
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
