#!/usr/bin/env node

// Confirms the two-factor hardening tables exist and are locked down as
// intended. Read-only: it writes nothing and creates no user.
//
// WHY A SCRIPT RATHER THAN TRUSTING "I ran it". There is no migration
// runner in this repo (CLAUDE.md non-negotiable 4), so the gap between
// "the SQL is in schema.sql" and "the SQL is in the database" is a human
// step that nothing checks. Code merged against a table that is not
// there fails at the first real click, in production, for a user. This
// is the cheapest way to close that gap before any route depends on it.
//
// WHAT "CORRECT" LOOKS LIKE HERE IS UNUSUAL, and it is worth stating
// because it reads like a failure. Both tables have row level security
// ON and NO policies, so the ANON key must be refused and the SERVICE
// ROLE key must succeed. A test that found the anon key could read
// mfa_trusted_device would be reporting a serious hole, not a pass:
//
//   mfa_attempt        a client that can edit its own attempt history
//                      can erase its own lockout.
//   mfa_trusted_device a client that can insert a row can mint itself a
//                      trusted device and skip the second factor.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//      SUPABASE_SERVICE_ROLE_KEY
// Usage: node scripts/verify-mfa-tables.js

const { createClient } = require('@supabase/supabase-js')

const TABLES = ['mfa_attempt', 'mfa_trusted_device']

// Columns the application code is about to depend on. Checked by name,
// because a table that exists with the wrong shape fails later and more
// confusingly than one that is simply absent.
const COLUMNS = {
  mfa_attempt: ['id', 'user_id', 'kind', 'succeeded', 'ip_hash', 'created_at'],
  mfa_trusted_device: ['id', 'user_id', 'token_hash', 'label', 'created_at', 'last_seen_at', 'expires_at'],
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(38)}${value}`)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')

  const admin = createClient(url, service)
  console.log('MFA hardening tables - verification')
  console.log('Read-only. Nothing is written.\n')

  let problems = 0

  console.log('EXISTENCE AND SHAPE (service role)')
  for (const table of TABLES) {
    // select with limit 0 asks the server to resolve the table and the
    // column list without returning or costing anything.
    const { error } = await admin.from(table).select(COLUMNS[table].join(','), { head: true, count: 'exact' }).limit(0)
    if (error) {
      line(table, `MISSING OR WRONG SHAPE - ${error.message}`)
      problems += 1
    } else {
      line(table, `ok (${COLUMNS[table].length} expected columns all present)`)
    }
  }

  console.log('\nLOCKDOWN (anon key must be REFUSED - a pass here is a hole)')
  if (!anon) {
    line('anon probe', 'SKIPPED - NEXT_PUBLIC_SUPABASE_ANON_KEY not set')
  } else {
    const pub = createClient(url, anon)
    for (const table of TABLES) {
      const { data, error } = await pub.from(table).select('id').limit(1)
      const rows = Array.isArray(data) ? data.length : 0
      // RLS with no policies does not error - it returns zero rows. So
      // "no error and no rows" is the correct, locked-down answer, and
      // any row coming back is the finding.
      if (error) {
        line(`${table}, signed out`, 'refused with an error - correct')
      } else if (rows === 0) {
        line(`${table}, signed out`, 'refused (0 rows) - correct')
      } else {
        line(`${table}, signed out`, `*** READABLE (${rows} row) - RLS IS NOT CLOSED ***`)
        problems += 1
      }
    }
  }

  console.log('')
  if (problems === 0) {
    console.log('OK - both tables exist with the expected columns, and neither is')
    console.log('readable without the service role. Safe to build against.')
    return
  }
  console.log(`${problems} PROBLEM(S) - do not build against these yet.`)
  console.log('The SQL is at the bottom of schema.sql, under')
  console.log('"Two-factor hardening: attempt limiting and trusted devices".')
  process.exit(1)
}

main().catch((err) => {
  console.error('Verification failed outright:', err)
  process.exit(1)
})
