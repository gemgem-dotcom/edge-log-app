import { createClient } from '@supabase/supabase-js'

// Every table that references auth.users. deleteUser fails if any row still
// points at the user, and the failure surfaces as an unhelpful empty error,
// so these have to be cleared first — and in an order that respects the
// foreign keys between them.
const USER_TABLES = ['trades', 'strategies', 'instruments', 'login_events']

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

  // Report a failed cleanup rather than pressing on to deleteUser, which
  // would then fail for a reason that looks unrelated.
  for (const table of USER_TABLES) {
    const { error } = await admin.from(table).delete().eq('user_id', userId)
    if (error) {
      return new Response(
        JSON.stringify({ error: `Could not remove your ${table.replace('_', ' ')}: ${error.message}` }),
        { status: 500 },
      )
    }
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId)

  if (deleteError) {
    return new Response(
      JSON.stringify({ error: deleteError.message || 'Could not delete the account.' }),
      { status: 500 },
    )
  }

  return new Response(JSON.stringify({ success: true }), { status: 200 })
}
