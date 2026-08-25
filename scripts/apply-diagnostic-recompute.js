#!/usr/bin/env node
// TEMPORARY, one-time write - not part of the app, never meant to be
// merged. Writes exactly the "after" values already shown in PR #122's
// roll-aware diagnostic (see that PR's conversation for the full before/
// after table) - hardcoded here deliberately, not re-derived, so this
// write can never produce a different number than what was already
// reported and reviewed. Excludes 7e8616fb-334b-4465-8a2f-e572b634df5a and
// 137c4594-c6d0-40f1-904f-acb9e71d9ef6 (see NOTES.md's "Known excursion
// data issues" - both need manual review, neither is touched here).
const { createClient } = require('@supabase/supabase-js')

const UPDATES = [
  { id: '076af9b3-312c-47c8-9987-1e6176545a6b', mfe_points: 258.00, mae_points: -12.00, drawdown_seconds: 0, excursion_fallback: true },
  { id: '20212645-30c0-457d-a310-0158b1b4350a', mfe_points: 164.50, mae_points: 27.25, drawdown_seconds: 360, excursion_fallback: false },
  { id: '4f68b28d-0f09-4799-85da-2110d63a7153', mfe_points: 218.25, mae_points: 22.50, drawdown_seconds: 360, excursion_fallback: false },
  { id: '4e7a02bd-b693-4d6d-b8b2-75d0849b14ce', mfe_points: 388.50, mae_points: 9.50, drawdown_seconds: 60, excursion_fallback: false },
  { id: '7f35d88d-e827-42be-88cc-5e6cc3e2bf88', mfe_points: 241.75, mae_points: 51.75, drawdown_seconds: 2220, excursion_fallback: false },
  { id: '0fa6e1f6-044e-40d6-863a-e4bbca13783e', mfe_points: 346.25, mae_points: 36.50, drawdown_seconds: 480, excursion_fallback: false },
  { id: '87daa4d6-a63f-4e3a-81cd-0b9b343b3f63', mfe_points: 265.50, mae_points: 1.00, drawdown_seconds: 60, excursion_fallback: false },
  { id: '533452d1-7865-420d-bdd3-cbaa48d29ab0', mfe_points: 226.25, mae_points: 21.75, drawdown_seconds: 480, excursion_fallback: false },
  { id: 'bd9bccf4-d285-4a08-b4da-bff592192c8c', mfe_points: 40.50, mae_points: 31.50, drawdown_seconds: 1740, excursion_fallback: false },
  { id: 'fad87aaa-173c-46e4-b01f-fcb33bc5e789', mfe_points: 136.25, mae_points: 13.00, drawdown_seconds: 360, excursion_fallback: false },
]

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  let written = 0
  for (const u of UPDATES) {
    const { id, ...values } = u
    const { data: before } = await admin.from('trades').select('mfe_points, mae_points, drawdown_seconds, excursion_fallback').eq('id', id).single()
    const { error } = await admin.from('trades').update(values).eq('id', id)
    if (error) {
      console.error(`FAILED ${id}: ${error.message}`)
      continue
    }
    written += 1
    console.log(`${id}: before=${JSON.stringify(before)} -> after=${JSON.stringify(values)}`)
  }
  console.log(`\nWritten: ${written} of ${UPDATES.length}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
