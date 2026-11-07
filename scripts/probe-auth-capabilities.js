#!/usr/bin/env node

// Read-only reconnaissance on what THIS project's auth server can actually
// do. Writes nothing, creates no user, signs nobody in, and sends no
// credential beyond the public anon key. Run it from the "Run a diagnostic
// script" workflow (Actions -> Run workflow).
//
// WHY THIS EXISTS. @supabase/auth-js 2.118 types advertise four factor
// types (totp, phone, webauthn, recovery_code), a passkey API and a
// recoveryCodes API. That is what the CLIENT can express. Whether the
// hosted auth server on this project implements the matching endpoints is
// a different question, and the answer decides what is worth building:
// a beautiful recovery-codes screen against an endpoint that 404s is
// worse than no screen, because it looks finished.
//
// HOW IT TELLS. Each endpoint is called WITHOUT a user session. The status
// separates "this route does not exist here" from "this route exists and
// quite rightly refused me":
//
//   404  the server has no such route - the feature is NOT available
//   401  the route exists and wants a session       -> AVAILABLE
//   400  the route exists and wants a better body   -> AVAILABLE
//   403  the route exists and is disabled by config -> present, switched off
//
// A 401 is therefore a PASS, which reads oddly in a log and is the whole
// trick: we are asking "does this door exist", not "will it let me in".
// Nothing here tries to get through one.
//
// The method matters as much as the path. A GET against a POST-only route
// answers 405 and tells you nothing about whether the feature exists, so
// each probe sends the verb the client really uses.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
// Usage: node scripts/probe-auth-capabilities.js

const TIMEOUT_MS = 15000
const GAP_MS = 250

// Paths lifted from @supabase/auth-js's own compiled client rather than
// from documentation, so they cannot drift from what the SDK calls.
const PROBES = [
  { group: 'Baseline', what: 'health - the auth server answers at all', method: 'GET', path: '/health', expectOpen: true },
  { group: 'Baseline', what: 'settings - what the project has switched on', method: 'GET', path: '/settings', expectOpen: true },

  { group: 'MFA (TOTP)', what: 'enroll a factor', method: 'POST', path: '/factors' },
  { group: 'MFA (TOTP)', what: 'challenge a factor', method: 'POST', path: '/factors/00000000-0000-0000-0000-000000000000/challenge' },
  { group: 'MFA (TOTP)', what: 'verify a challenge', method: 'POST', path: '/factors/00000000-0000-0000-0000-000000000000/verify' },
  { group: 'MFA (TOTP)', what: 'unenroll a factor', method: 'DELETE', path: '/factors/00000000-0000-0000-0000-000000000000' },

  { group: 'Recovery codes', what: 'generate / status', method: 'POST', path: '/factors/recovery-codes' },
  { group: 'Recovery codes', what: 'regenerate', method: 'POST', path: '/factors/recovery-codes/regenerate' },
  { group: 'Recovery codes', what: 'verify a code', method: 'POST', path: '/factors/recovery-codes/verify' },

  { group: 'Passkeys', what: 'registration options', method: 'POST', path: '/passkeys/registration/options' },
  { group: 'Passkeys', what: 'registration verify', method: 'POST', path: '/passkeys/registration/verify' },
  { group: 'Passkeys', what: 'authentication options', method: 'POST', path: '/passkeys/authentication/options' },
  { group: 'Passkeys', what: 'authentication verify', method: 'POST', path: '/passkeys/authentication/verify' },
  { group: 'Passkeys', what: 'list passkeys', method: 'GET', path: '/passkeys' },

  { group: 'Re-authentication', what: 'reauthenticate', method: 'GET', path: '/reauthenticate' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(base, anon, method, path) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        apikey: anon,
        'Content-Type': 'application/json',
        // No Authorization header on purpose. A probe that signed in would
        // be testing a session, not the server's route table.
      },
      // POST routes here reject an absent body with a parse error rather
      // than a clean 400, which muddies the reading. An empty object is
      // the smallest well-formed thing to send.
      body: method === 'POST' ? '{}' : undefined,
      signal: ctrl.signal,
    })
    let text = ''
    try { text = (await res.text()).slice(0, 400) } catch { /* body is optional here */ }
    return { ok: true, status: res.status, body: text }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message }
  } finally {
    clearTimeout(timer)
  }
}

// The whole point of the script, in one function: turn a status into a
// statement about the FEATURE rather than about the request.
function verdictFor(status, expectOpen) {
  if (expectOpen) return status === 200 ? ['OK', true] : [`unexpected ${status}`, false]
  if (status === 404) return ['NOT AVAILABLE - no such route on this server', false]
  if (status === 401) return ['available (refused us, correctly - no session)', true]
  if (status === 400) return ['available (route exists, rejected our empty body)', true]
  if (status === 403) return ['present but FORBIDDEN - likely disabled in project config', false]
  if (status === 422) return ['available (route exists, body failed validation)', true]
  if (status === 405) return ['inconclusive - wrong verb for this route', false]
  if (status === 429) return ['available (rate limited before it could answer)', true]
  return [`inconclusive - status ${status}`, false]
}

async function main() {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '')
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!base || !anon) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set')
  }
  const authBase = `${base}/auth/v1`

  console.log('Auth capability probe')
  console.log('Read-only: no user created, nothing written, no session used.')
  console.log('A 401 is a PASS - it means the route exists and refused an anonymous caller.\n')

  const available = {}
  let group = null

  for (const p of PROBES) {
    if (p.group !== group) {
      group = p.group
      console.log(`\n${group}`)
      console.log('-'.repeat(68))
    }
    const res = await call(authBase, anon, p.method, p.path)
    if (!res.ok) {
      console.log(`  ${p.method.padEnd(6)} ${p.what.padEnd(42)} FAILED: ${res.error}`)
      available[group] = false
      await sleep(GAP_MS)
      continue
    }
    const [verdict, good] = verdictFor(res.status, p.expectOpen)
    console.log(`  ${p.method.padEnd(6)} ${p.what.padEnd(42)} ${String(res.status).padEnd(4)} ${verdict}`)

    // settings is the one response whose BODY is worth reading - it lists
    // what the project has switched on, which no status code can tell us.
    if (p.path === '/settings' && res.status === 200) {
      try {
        const s = JSON.parse(res.body)
        const flags = Object.entries(s)
          .filter(([, v]) => typeof v === 'boolean')
          .map(([k, v]) => `${k}=${v}`)
        if (flags.length) console.log(`         flags: ${flags.join('  ')}`)
      } catch { /* a body we cannot parse is not a failure of the probe */ }
    }

    // A group counts as available only if EVERY route in it does. A
    // half-present feature is not one to build against.
    available[group] = available[group] === undefined ? good : (available[group] && good)
    await sleep(GAP_MS)
  }

  console.log(`\n${'='.repeat(68)}`)
  console.log('WHAT THIS MEANS FOR THE BUILD')
  console.log('='.repeat(68))
  for (const [g, ok] of Object.entries(available)) {
    if (g === 'Baseline') continue
    console.log(`  ${ok ? 'BUILD IT   ' : 'DO NOT BUILD'}  ${g}`)
  }
  console.log('')
  console.log('"DO NOT BUILD" means the endpoint is missing or switched off on this')
  console.log('project. Shipping UI against it produces a screen that looks finished')
  console.log('and fails on the first real click - worse than not shipping it.')
  console.log('')
  console.log('Note what this probe does NOT tell you: whether recovery codes need')
  console.log("the client's experimental flag (they do - the flag is client-side and")
  console.log('cannot be seen from here), and whether passkeys have a correct relying')
  console.log('party ID configured for the production domain. Both are checked by')
  console.log('using them, not by asking the route table.')
}

main().catch((err) => {
  console.error('Probe failed outright:', err)
  process.exit(1)
})
