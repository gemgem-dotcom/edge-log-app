#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js')
async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const ids = ['076af9b3-312c-47c8-9987-1e6176545a6b', '7e8616fb-334b-4465-8a2f-e572b634df5a']
  for (const id of ids) {
    const { data, error } = await admin.from('trades').select('id, trade_date, trade_time, entry, exit_time, exit_price, market_data_status, mfe_points, mae_points, drawdown_seconds, excursion_fallback, trade_time_unverified').eq('id', id).single()
    console.log(error ? `${id}: ERROR ${error.message}` : JSON.stringify(data))
  }
  const { data: stillPending } = await admin.from('trades').select('id, trade_date, trade_time').eq('market_data_status', 'pending')
  console.log('Still pending trades:', JSON.stringify(stillPending))
}
main().catch((e) => { console.error(e); process.exit(1) })
