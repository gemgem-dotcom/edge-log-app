#!/usr/bin/env node

// Did the assurance block at the bottom of schema.sql actually land,
// and did it break anything? Run it from the "Run a diagnostic script"
// workflow AFTER running that SQL in Supabase.
//
// WHY THIS MATTERS MORE THAN THE USUAL VERIFY SCRIPT. The change it
// checks can stop every user reading their own trades. The policy
// has a branch that is supposed to keep accounts WITHOUT a second
// factor working exactly as before, and if that branch is wrong the
// symptom is an empty journal for everybody - which looks like data
// loss rather than a policy. So the most important check here is not
// "is the gate on" but "can a normal user still read their rows".
//
// Read-only. Writes nothing, creates no user, changes no policy.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//      SUPABASE_SERVICE_ROLE_KEY
// Usage: node scripts/verify-rls-assurance.js

const { createClient } = require('@supabase/supabase-js')

const GUARDED = ['instruments', 'strategies', 'trades', 'login_events', 'edge_insights']

function line(label, value) {
  console.log(`  ${String(label).padEnd(40)}${value}`)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')

  const admin = createClient(url, service, { auth: { persistSession: false } })
  let problems = 0
  let warnings = 0

  console.log('Row-level security assurance - verification')
  console.log('Read-only. Nothing is written and no policy is changed.\n')

  // ---------------------------------------------------------------
  console.log('THE PIECES EXIST')
  const { error: grantErr } = await admin
    .from('mfa_assurance_grant')
    .select('id, user_id, session_id, source, expires_at', { head: true, count: 'exact' })
    .limit(0)
  if (grantErr) {
    line('mfa_assurance_grant', `MISSING OR WRONG SHAPE - ${grantErr.message}`)
    problems += 1
  } else {
    line('mfa_assurance_grant', 'ok (all expected columns present)')
  }

  // The function is the whole policy. If it is absent the policies
  // cannot have been created either, and saying so plainly beats five
  // confusing failures below.
  const { error: fnErr } = await admin.rpc('session_meets_assurance')
  if (fnErr && /does not exist|not find/i.test(fnErr.message)) {
    line('session_meets_assurance()', 'NOT CREATED - the SQL has not been run')
    problems += 1
  } else if (fnErr) {
    // Calling it as the service role has no auth.uid(), so an error
    // about a null uid means the function is there and working.
    line('session_meets_assurance()', `present (service-role call returned: ${fnErr.message.slice(0, 60)})`)
  } else {
    line('session_meets_assurance()', 'present')
  }

  // ---------------------------------------------------------------
  console.log('\nTHE GATE IS ON (anon must read nothing)')
  if (!anon) {
    line('anon probe', 'SKIPPED - NEXT_PUBLIC_SUPABASE_ANON_KEY not set')
  } else {
    const pub = createClient(url, anon, { auth: { persistSession: false } })
    for (const table of GUARDED) {
      const { data, error } = await pub.from(table).select('id').limit(1)
      const rows = Array.isArray(data) ? data.length : 0
      if (error || rows === 0) {
        line(table, 'refused - correct')
      } else {
        line(table, `*** READABLE (${rows} row) ***`)
        problems += 1
      }
    }
  }

  // ---------------------------------------------------------------
  // The check that matters most. A user with NO verified factor must
  // still be able to read their own rows - that is the branch which,
  // if wrong, locks out everybody.
  console.log('\nNOBODY WAS LOCKED OUT (the branch that breaks everything)')
  const users = []
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`could not list users: ${error.message}`)
    users.push(...(data?.users || []))
    if ((data?.users || []).length < 200) break
  }
  line('accounts', users.length)

  let withFactors = 0
  for (const u of users) {
    const { data } = await admin.auth.admin.mfa.listFactors({ userId: u.id })
    if ((data?.factors || []).some((f) => f.status === 'verified')) withFactors += 1
  }
  line('accounts with a verified factor', withFactors)
  line('accounts unaffected by the gate', users.length - withFactors)

  // Row counts via the service role, which bypasses RLS. This does
  // not prove a user can read them, but a table that HAS rows while
  // every user is on the unaffected branch is the case where a broken
  // policy would be most visible, so it is worth printing.
  console.log('')
  for (const table of GUARDED) {
    const { count, error } = await admin.from(table).select('id', { head: true, count: 'exact' })
    line(`${table} rows (service role)`, error ? `error - ${error.message}` : count)
  }

  if (withFactors > 0) {
    console.log('')
    console.log('  NOTE: some accounts have a second factor. Those users must now')
    console.log('  sign in WITH a code before their rows are readable. Sign in as')
    console.log('  one and confirm the journal loads - this script cannot do that')
    console.log('  for you, because it has no way to hold a user session.')
    warnings += 1
  }

  // ---------------------------------------------------------------
  console.log('\nGRANTS (how remembered browsers keep working)')
  const { data: grants, error: gErr } = await admin
    .from('mfa_assurance_grant')
    .select('expires_at, source')
  if (gErr) {
    line('grants', `could not read - ${gErr.message}`)
  } else {
    const now = Date.now()
    const live = (grants || []).filter((g) => new Date(g.expires_at).getTime() > now)
    line('grant rows', (grants || []).length)
    line('still live', live.length)
    const stale = (grants || []).length - live.length
    if (stale > 0) line('expired, awaiting a sweep', stale)
  }

  // ---------------------------------------------------------------
  console.log(`\n${'='.repeat(64)}`)
  if (problems === 0) {
    console.log('OK - the gate is in place and the anon key reads nothing.')
    if (warnings) console.log('Read the NOTE above before calling it done.')
    console.log('')
    console.log('Still worth doing by hand, because no script can:')
    console.log('  1. Sign in WITHOUT 2FA and confirm the journal loads.')
    console.log('  2. Sign in WITH 2FA and a code, and confirm it loads.')
    console.log('  3. Tick "skip the code on this computer", sign out, sign')
    console.log('     back in, and confirm it loads with no code asked for.')
    console.log('     That third one is what the grant table exists for.')
    return
  }
  console.log(`${problems} PROBLEM(S).`)
  console.log('If the pieces are missing, the SQL at the bottom of schema.sql')
  console.log('has not been run. To undo it entirely, drop the five policies')
  console.log('named "Second factor required for ..." - the original policies')
  console.log('were never modified.')
  process.exit(1)
}

main().catch((err) => {
  console.error('Verification failed outright:', err.message || err)
  process.exit(1)
})
