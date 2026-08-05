'use client'

// Google sign-in redirects the browser back here once the provider
// has approved the login. supabaseClient.js uses the browser-only
// supabase-js client (no @supabase/ssr), so the PKCE code verifier it
// stored before the redirect only exists in this browser's localStorage —
// a server route handler has no access to it. Finishing the exchange has
// to happen client-side, in the same browser that started it.
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
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
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) {
          goToLoginWithError(router, error.message)
        } else {
          router.replace('/app')
        }
        return
      }

      // No ?code= and no error param - either the provider used the
      // implicit flow (tokens in the URL hash, already parsed by
      // detectSessionInUrl by the time this runs) or something went wrong.
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
