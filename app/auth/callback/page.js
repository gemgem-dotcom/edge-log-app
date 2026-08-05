'use client'

// Google/Apple sign-in redirects the browser back here once the provider
// has approved the login. supabaseClient.js uses the browser-only
// supabase-js client (no @supabase/ssr), so the PKCE code verifier it
// stored before the redirect only exists in this browser's localStorage —
// a server route handler has no access to it. Finishing the exchange has
// to happen client-side, in the same browser that started it.
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import PageLoading from '@/components/PageLoading'

export default function AuthCallbackPage() {
  const router = useRouter()

  useEffect(() => {
    async function finish() {
      const code = new URLSearchParams(window.location.search).get('code')
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        router.replace(error ? '/login?error=oauth' : '/app')
        return
      }
      // No ?code= present — either the provider used the implicit flow
      // (tokens in the URL hash, already parsed by detectSessionInUrl by
      // the time this runs) or something went wrong.
      const { data } = await supabase.auth.getSession()
      router.replace(data?.session ? '/app' : '/login?error=oauth')
    }
    finish()
  }, [router])

  return <PageLoading />
}
