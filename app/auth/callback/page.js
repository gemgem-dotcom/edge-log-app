'use client'

// Google sign-in redirects the browser back here once the provider has
// approved the login. supabaseClient.js's shared `supabase` client keeps
// detectSessionInUrl on, because reset-password/page.js needs it to pick
// up its own recovery link and fire PASSWORD_RECOVERY. But that same
// auto-detection would also try to consume this page's ?code= on its
// own, racing the explicit exchange below for the one-time PKCE
// verifier in localStorage - whichever runs first deletes it, so the
// other fails with "PKCE code verifier not found in storage." The code
// exchange here therefore runs on its own page-local client with
// detectSessionInUrl off, so nothing else on this page ever touches the
// code param. It still shares the shared client's storage key, so the
// session it saves is picked up by the rest of the app immediately.
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { supabase, supabaseUrl, supabaseAnonKey } from '@/lib/supabaseClient'
import PageLoading from '@/components/PageLoading'

const GENERIC_OAUTH_ERROR = 'Something went wrong signing in with Google. Please try again.'

function goToLoginWithError(router, message) {
  const params = new URLSearchParams({ error: 'oauth', message: message || GENERIC_OAUTH_ERROR })
  router.replace(`/login?${params.toString()}`)
}

export default function AuthCallbackPage() {
  const router = useRouter()

  useEffect(() => {
    async function finish() {
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
        const exchangeClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { flowType: 'pkce', detectSessionInUrl: false },
        })
        const { error } = await exchangeClient.auth.exchangeCodeForSession(code)
        if (error) {
          goToLoginWithError(router, error.message)
        } else {
          router.replace('/app')
        }
        return
      }

      // No ?code= and no error param - either the provider used the
      // implicit flow (tokens in the URL hash, already parsed by the
      // shared client's own detectSessionInUrl by the time this runs) or
      // something went wrong.
      const { data } = await supabase.auth.getSession()
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
