#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js')
async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const { data, error } = await admin.from('trades').select('id, trade_date, trade_time, market_data_status, mfe_points, mae_points, drawdown_seconds, excursion_fallback').eq('id', 'eee450d9-4a85-4856-adaa-2901066db337').single()
  console.log(error ? error.message : JSON.stringify(data))
}
main().catch((e) => { console.error(e); process.exit(1) })
