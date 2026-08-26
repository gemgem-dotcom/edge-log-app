#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js')
async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const { data, error } = await admin.from('trades')
    .select('id, trade_date, trade_time, direction, entry, stop, target, exit_price, exit_time, market_data_status, mfe_points, mae_points, drawdown_seconds, excursion_fallback, trade_time_unverified, tags')
    .eq('trade_date', '2026-06-24')
  if (error) throw new Error(error.message)
  console.log(JSON.stringify(data, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
