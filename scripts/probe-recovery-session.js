#!/usr/bin/env node

// What does a PASSWORD-RECOVERY session actually look like to a server
// route? Run it from the "Run a diagnostic script" workflow with
// `user_email` set.
//
// WHY THIS EXISTS. The plan is that completing a password reset is the
// one way back into an account whose authenticator is lost: the reset
// finishes, a server route clears the user's factors, and they set 2FA
// up again. That route is the single most dangerous endpoint in the
// app - it switches two-factor authentication OFF - so it must be able
// to tell a genuine recovery session from an ordinary signed-in one.
// Someone who merely stole a password must not be able to call it.
//
// Everything about that hinges on two claims inside the recovery
// session's JWT, and both were assumptions:
//
//   aal   expected 'aal1'. If a recovery session were already aal2 the
//         whole problem would evaporate - the client could unenroll the
//         factor itself and no server route would be needed at all.
//   amr   expected to name how the session was obtained. auth-js's own
//         AMRMethod union lists password, otp, oauth, magiclink and the
//         mfa/* methods - and NO 'recovery'. So a recovery link most
//         likely lands as 'otp', which this app never otherwise issues.
//         "Most likely" is not good enough for the gate on turning 2FA
//         off, which is why this runs against the real auth server.
//
// It also checks the other half: whether a recovery session is in fact
// refused when it tries to unenroll a factor directly. If it is NOT
// refused, there is no need for a service-role route and the simpler
// design wins.
//
// SIDE EFFECTS, stated plainly because this one is not purely read-only:
// it mints a recovery token for the named user and consumes it. It does
// NOT send an email (generateLink deliberately does not), does NOT
// change the password, and does NOT sign anyone out. The only lasting
// effect is that a recovery email that user requested in the last hour
// and has not yet clicked may stop working, and they would need to
// request another.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//      SUPABASE_SERVICE_ROLE_KEY, USER_EMAIL
// Usage: node scripts/probe-recovery-session.js

const { createClient } = require('@supabase/supabase-js')

function decodeClaims(jwt) {
  // Decode only. The token came straight from the auth server over TLS
  // moments ago, so there is nothing here to verify against an attacker;
  // a real server route would validate it properly instead.
  const body = String(jwt || '').split('.')[1]
  if (!body) return null
  const pad = body.length % 4 ? '='.repeat(4 - (body.length % 4)) : ''
  return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8'))
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(26)}${value}`)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  const email = process.env.USER_EMAIL
  if (!url || !anon || !service) throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are not set')
  if (!email) throw new Error('USER_EMAIL is not set - pass it as the user_email workflow input')

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })

  console.log('Password-recovery session probe')
  console.log(`Account: ${email}`)
  console.log('Mints and consumes one recovery token. No email is sent, no password changes.\n')

  // ---------------------------------------------------------------
  console.log("THE ACCOUNT'S FACTORS, as the admin API sees them")
  // Paged, because listUsers caps a page and a missed page would read as
  // "no such user" - which is exactly how this probe failed first time.
  const users = []
  for (let page = 1; page <= 20; page += 1) {
    const { data: pageData, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (listErr) throw new Error(`could not list users: ${listErr.message}`)
    const batch = pageData?.users || []
    users.push(...batch)
    if (batch.length < 200) break
  }
  const user = users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase())
  if (!user) {
    // Masked, never the addresses themselves. This log is a CI artifact
    // on a repo that may not stay private, and the point here is only to
    // tell the operator which account to name - not to publish a user
    // list to anyone who can read a build log.
    const mask = (e) => {
      const [name = '', host = ''] = String(e || '').split('@')
      const head = name.slice(0, 1) || '?'
      const tail = name.length > 1 ? name.slice(-1) : ''
      return `${head}${'*'.repeat(Math.max(1, name.length - 2))}${tail}@${host}`
    }
    console.log(`\n  No account with that email. This project has ${users.length} user(s):`)
    for (const u of users) line('', `${mask(u.email)}  (${(u.factors || []).filter((f) => f.status === 'verified').length} verified factor(s))`)
    throw new Error(`no user with the email ${email} - pick one of the masked addresses above`)
  }
  line('user id', user.id)
  const { data: factorData } = await admin.auth.admin.mfa.listFactors({ userId: user.id })
  const factors = factorData?.factors || []
  line('factors', factors.length ? factors.map((f) => `${f.friendly_name || f.id} (${f.status})`).join(', ') : 'none')
  const verified = factors.filter((f) => f.status === 'verified')
  line('verified factors', verified.length)

  // ---------------------------------------------------------------
  console.log('\nTHE RECOVERY SESSION')
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: 'recovery', email })
  if (linkErr) throw new Error(`could not generate a recovery link: ${linkErr.message}`)
  const tokenHash = linkData?.properties?.hashed_token
  if (!tokenHash) throw new Error('the generated link carried no hashed_token')
  line('recovery link', 'generated (not emailed)')

  const pub = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: sessionData, error: otpErr } = await pub.auth.verifyOtp({ type: 'recovery', token_hash: tokenHash })
  if (otpErr) throw new Error(`could not exchange the recovery token: ${otpErr.message}`)
  const session = sessionData?.session
  if (!session) throw new Error('the exchange returned no session')

  const claims = decodeClaims(session.access_token)
  line('aal claim', claims?.aal ?? '(absent)')
  const amr = claims?.amr
  const amrMethods = Array.isArray(amr)
    ? amr.map((e) => (typeof e === 'string' ? e : e?.method)).filter(Boolean)
    : []
  line('amr claim', amr ? JSON.stringify(amr) : '(absent)')
  line('amr methods', amrMethods.length ? amrMethods.join(', ') : '(none)')
  line('session_id', claims?.session_id ? 'present' : '(absent)')

  // ---------------------------------------------------------------
  console.log('\nWHAT THAT SESSION IS ALLOWED TO DO')
  const { data: aalData } = await pub.auth.mfa.getAuthenticatorAssuranceLevel()
  line('currentLevel', aalData?.currentLevel ?? '(none)')
  line('nextLevel', aalData?.nextLevel ?? '(none)')

  // The question that decides the design: can this session switch 2FA
  // off by itself?
  //
  // This asks with a well-formed UUID that belongs to nobody, NOT with
  // one of the account's real factors. Using a real one would answer the
  // question more sharply - a "not found" tells us nothing about whether
  // an assurance check would have run first - but the cost of the other
  // outcome is that the probe silently strips the user's two-factor
  // authentication while reporting on it. A diagnostic that can break
  // the thing it is diagnosing is not one to run against a live account,
  // so this accepts the weaker answer.
  const NOBODYS_FACTOR = '00000000-0000-4000-8000-000000000000'
  const { error: unenrollErr } = await pub.auth.mfa.unenroll({ factorId: NOBODYS_FACTOR })
  if (!unenrollErr) {
    line('unenroll from aal1', 'accepted a non-existent factor id (?) - inspect manually')
  } else {
    const code = unenrollErr.code || unenrollErr.status || ''
    line('unenroll from aal1', `refused - ${code} ${unenrollErr.message}`.trim())
    line('  refusal is about', /assurance|aal|insufficient/i.test(`${code} ${unenrollErr.message}`)
      ? 'ASSURANCE LEVEL - the aal2 gate is real and runs first'
      : 'the missing factor - the aal2 gate is untested by this probe')
  }

  // ---------------------------------------------------------------
  console.log(`\n${'='.repeat(68)}`)
  console.log('WHAT THIS MEANS FOR THE BUILD')
  console.log('='.repeat(68))
  const isAal1 = claims?.aal === 'aal1'
  const distinctive = amrMethods.length === 1 && amrMethods[0] !== 'password'
  console.log(`  recovery session is aal1 ........ ${isAal1 ? 'yes' : `NO (${claims?.aal})`}`)
  console.log(`  amr distinguishes it ............ ${distinctive ? `yes, "${amrMethods[0]}"` : 'NO - see the amr claim above'}`)
  console.log('')
  if (!distinctive) {
    console.log('  The clear-2FA route CANNOT safely key off amr alone. It must')
    console.log('  fail closed and the design needs rethinking - a route that')
    console.log('  turns 2FA off for any aal1 session is worse than no 2FA,')
    console.log('  because a stolen password would be enough to call it.')
  } else {
    console.log(`  The clear-2FA route should require amr to contain exactly`)
    console.log(`  "${amrMethods[0]}" and nothing else, and refuse everything else.`)
  }
}

main().catch((err) => {
  console.error('Probe failed outright:', err.message || err)
  process.exit(1)
})
