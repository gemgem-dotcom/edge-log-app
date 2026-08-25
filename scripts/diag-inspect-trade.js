#!/usr/bin/env node
// TEMPORARY, read-only diagnostic - inspects one trade's raw logged
// fields for internal plausibility (entry/exit/stop/target/direction).
// Not part of the app, never meant to be merged.
const { createClient } = require('@supabase/supabase-js')

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)
  const TRADE_ID = '7e8616fb-334b-4465-8a2f-e572b634df5a'
  const { data: trade, error } = await admin.from('trades').select('*').eq('id', TRADE_ID).single()
  if (error) throw new Error(error.message)
  console.log(JSON.stringify(trade, null, 2))
}
main().catch((err) => { console.error(err); process.exit(1) })
