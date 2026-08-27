import { createClient } from '@supabase/supabase-js'

// Every table that references auth.users. deleteUser fails if any row still
// points at the user, and the failure surfaces as an unhelpful empty error,
// so these have to be cleared first — and in an order that respects the
// foreign keys between them. edge_beliefs was missing here for a while
// (added in a later feature, after this list was written) - a belief row
// exists per (user, dimension-slice) and gets created on a user's very
// first trade, so this silently blocked deleting the account of anyone
// who'd ever logged one. schema.sql now also puts an `on delete cascade`
// backstop on that FK (same fix already applied to login_events once
// before), but it's kept in this explicit list too, consistent with every
// other table here.
const USER_TABLES = ['trades', 'strategies', 'instruments', 'login_events', 'edge_beliefs']

export async function POST(req) {
  try {
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
  } catch (err) {
    // Anything unexpected (a thrown exception rather than a returned
    // {error}) would otherwise crash the route and hand the client a
    // non-JSON body, which is indistinguishable from every other failure
    // once it gets to DangerZoneSection's generic fallback message. Surface
    // whatever actually happened instead.
    return new Response(
      JSON.stringify({ error: err?.message || 'Could not delete the account.' }),
      { status: 500 },
    )
  }
}
