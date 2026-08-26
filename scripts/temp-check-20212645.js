#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js')
async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const { data, error } = await admin.from('trades').select('*').eq('id', '20212645-30c0-457d-a310-0158b1b4350a').single()
  if (error) throw new Error(error.message)
  console.log(JSON.stringify(data, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
