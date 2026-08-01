import { createClient } from '@supabase/supabase-js'

export async function POST(req) {
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '').trim()

if (!token) {
  return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const admin = createClient(supabaseUrl, serviceKey)

const { data: userData, error: userError } = await admin.auth.getUser(token)

if (userError || !userData || !userData.user) {
  return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 })
}

const userId = userData.user.id

const { data: trades } = await admin.from('trades').select('id').eq('user_id', userId)
  const tradeIds = (trades || []).map((t) => t.id)

if (tradeIds.length > 0) {
  await admin.from('exit_legs').delete().in('trade_id', tradeIds)
}

await admin.from('trades').delete().eq('user_id', userId)
  await admin.from('strategies').delete().eq('user_id', userId)
  await admin.from('instruments').delete().eq('user_id', userId)

const { error: deleteError } = await admin.auth.admin.deleteUser(userId)

if (deleteError) {
  return new Response(JSON.stringify({ error: deleteError.message }), { status: 500 })
}

return new Response(JSON.stringify({ success: true }), { status: 200 })
}
