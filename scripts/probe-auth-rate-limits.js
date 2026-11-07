#!/usr/bin/env node

// What does this project's auth server ALREADY do about repeated
// verification attempts? Run it from the "Run a diagnostic script"
// workflow.
//
// WHY THIS EXISTS. A rate limit is about to be built on EdgeLog's own
// login path, and it is worth knowing first whether it is the only
// thing standing between an account and a brute force, or a second
// layer on top of one the auth server already applies. The answer
// changes what the code should say about itself and what the handover
// guide should promise - and "I think Supabase limits this" is not
// something to write down without checking.
//
// It matters more than usual here because of where TOTP verification
// happens. supabase.auth.mfa.verify() runs IN THE BROWSER and talks to
// the auth server directly; EdgeLog's own code is not in that path at
// all. So an application-level limiter cannot actually PREVENT an
// attempt - someone scripting against the public API skips it
// entirely. Whatever the auth server does is therefore the real floor,
// and this measures it.
//
// HOW. It sends a burst of verification attempts with no session and
// watches for the status to change. 401 means "no session" and is the
// expected answer; the moment one comes back 429 the server has
// started refusing on volume rather than on credentials, and the count
// at which that happens is the limit.
//
// SIDE EFFECTS. It consumes this project's rate-limit budget for
// whatever window the server applies, from the RUNNER's IP address.
// GoTrue's verification limits are applied per IP, so a real user
// signing in from their own address is unaffected - but if these
// limits turn out to be per project rather than per IP, a user signing
// in during the next hour could be refused. The burst is kept small
// for that reason, and no valid credential is ever sent.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
// Usage: node scripts/probe-auth-rate-limits.js

const BURST = 20
// 400ms rather than 150. The first run hammered at 150ms and the
// connection stalled after five requests - which may have BEEN the
// server shedding load, but is indistinguishable from a flaky runner.
// A slower burst separates "refused me" from "never answered".
const GAP_MS = 400
const TIMEOUT_MS = 20000

const FAKE_FACTOR = '00000000-0000-4000-8000-000000000000'

const TARGETS = [
  {
    what: 'MFA verify',
    method: 'POST',
    path: `/factors/${FAKE_FACTOR}/verify`,
    body: { challenge_id: FAKE_FACTOR, code: '000000' },
  },
  {
    what: 'password sign-in',
    method: 'POST',
    path: '/token?grant_type=password',
    body: { email: 'nobody-probe@example.invalid', password: 'not-a-real-password' },
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(base, anon, t) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${t.path}`, {
      method: t.method,
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify(t.body),
      signal: ctrl.signal,
    })
    let text = ''
    try { text = (await res.text()).slice(0, 200) } catch { /* body optional */ }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: text }
  } catch (err) {
    return { status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '')
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!base || !anon) throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set')
  const authBase = `${base}/auth/v1`

  console.log('Auth rate-limit probe')
  console.log(`Sends up to ${BURST} failing attempts per endpoint, from this runner's IP.`)
  console.log('No valid credential is ever sent and nothing is written.\n')

  const findings = []

  for (const t of TARGETS) {
    console.log(`${t.what}  (${t.method} ${t.path.split('?')[0]})`)
    console.log('-'.repeat(68))
    const counts = new Map()
    let limitedAt = null
    let stoppedEarlyAt = null
    let retryAfter = null
    let firstLimitedBody = ''

    for (let i = 1; i <= BURST; i += 1) {
      const res = await call(authBase, anon, t)
      counts.set(res.status, (counts.get(res.status) || 0) + 1)
      if (res.status === 429 && limitedAt === null) {
        limitedAt = i
        retryAfter = res.retryAfter
        firstLimitedBody = res.body
        console.log(`  attempt ${String(i).padStart(2)}  429 - rate limited`)
        break
      }
      if (res.status === 0) {
        // Retry once. A single timeout is noise; two in a row at the
        // same point is a finding worth reporting as one.
        const retry = await call(authBase, anon, t)
        if (retry.status === 0) {
          console.log(`  attempt ${String(i).padStart(2)}  no answer twice: ${res.error}`)
          stoppedEarlyAt = i
          break
        }
        counts.set(retry.status, (counts.get(retry.status) || 0) + 1)
        if (retry.status === 429) { limitedAt = i; retryAfter = retry.retryAfter; firstLimitedBody = retry.body; break }
      }
    }

    const summary = [...counts.entries()].map(([s, n]) => `${n}x ${s}`).join(', ')
    const sent = [...counts.values()].reduce((a, b) => a + b, 0)
    console.log(`  statuses seen: ${summary}  (${sent} answered of ${BURST} planned)`)
    if (limitedAt === null && stoppedEarlyAt !== null) {
      // The distinction that matters. The first version of this script
      // printed "not rate limited within 20 attempts" after managing
      // five - a false statement, and precisely the kind that gets
      // copied into a handover document as if it were a measurement.
      console.log(`  INCONCLUSIVE - the burst stopped at attempt ${stoppedEarlyAt} without an answer,`)
      console.log('  so nothing here says whether a limit exists')
    } else if (limitedAt === null) {
      console.log(`  NOT rate limited within ${BURST} attempts`)
    } else {
      console.log(`  rate limited at attempt ${limitedAt}`)
      if (retryAfter) console.log(`  retry-after: ${retryAfter}`)
      if (firstLimitedBody) console.log(`  server said: ${firstLimitedBody}`)
    }
    findings.push({ what: t.what, limitedAt, stoppedEarlyAt })
    console.log('')
  }

  console.log('='.repeat(68))
  console.log('WHAT THIS MEANS FOR THE BUILD')
  console.log('='.repeat(68))
  const mfa = findings.find((f) => f.what === 'MFA verify')
  if (mfa && mfa.limitedAt !== null) {
    console.log(`  The auth server already refuses MFA verification on volume`)
    console.log(`  (at attempt ${mfa.limitedAt} from one IP). An application-level`)
    console.log(`  limiter is a SECOND layer, not the only one - say so rather`)
    console.log(`  than claiming EdgeLog is what stops a brute force.`)
  } else if (mfa && mfa.stoppedEarlyAt !== null) {
    console.log('  INCONCLUSIVE. The burst never completed, so this run says')
    console.log('  nothing either way. Do not write down that there is no')
    console.log('  server-side limit on the strength of it.')
  } else {
    console.log(`  No server-side refusal appeared within ${BURST} attempts.`)
    console.log('  That does NOT prove there is none - the window may be longer')
    console.log('  than this burst, or the limit may be per account rather than')
    console.log('  per IP. It does mean nothing observed here can be quoted as')
    console.log('  protection, and the application limiter should be written as')
    console.log('  if it were the only one.')
  }
  console.log('')
  console.log('Either way, remember where TOTP verification actually happens:')
  console.log('in the browser, against the auth server, with EdgeLog not in the')
  console.log('path. An application limiter raises the cost of attacking through')
  console.log('the app. It cannot stop someone scripting the public API.')
}

main().catch((err) => {
  console.error('Probe failed outright:', err.message || err)
  process.exit(1)
})
