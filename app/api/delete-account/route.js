import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'

// Every table that references auth.users. deleteUser fails if any row still
// points at the user, and the failure surfaces as an unhelpful empty error,
// so these have to be cleared first — and in an order that respects the
// foreign keys between them.
const USER_TABLES = ['trades', 'strategies', 'instruments', 'login_events']

// Deletes every object under this user's own path prefix in the private
// screenshots bucket (storage-setup.sql's RLS scopes that prefix to
// exactly this user's auth.uid()). Without this, a screenshot's storage
// object outlives the row that referenced it - and once deleteUser below
// succeeds, that uid can never again satisfy the bucket's RLS policy, so
// the object becomes a permanently orphaned, unreachable file rather than
// just an unreferenced one. Paginates past storage.list's default page
// size (100) instead of assuming everyone has fewer screenshots than
// that. Best-effort per page - a failed page is reported back to the
// caller as a warning rather than blocking account deletion on it, since
// leaving a few orphaned screenshots behind is a far smaller problem than
// refusing to let someone delete their account at all.
async function deleteUserScreenshots(admin, userId) {
  const PAGE_SIZE = 1000
  let offset = 0
  const failures = []
  while (true) {
    const { data: entries, error: listError } = await admin.storage
      .from('screenshots')
      .list(userId, { limit: PAGE_SIZE, offset })
    if (listError) { failures.push(listError.message); break }
    if (!entries || entries.length === 0) break

    const paths = entries.map((entry) => `${userId}/${entry.name}`)
    const { error: removeError } = await admin.storage.from('screenshots').remove(paths)
    if (removeError) failures.push(removeError.message)

    if (entries.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return failures
}

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

    // Best-effort, not blocking - see deleteUserScreenshots' own comment on
    // why a failure here shouldn't stop the rest of account deletion.
    const screenshotFailures = await deleteUserScreenshots(admin, userId)

    // Report a failed cleanup rather than pressing on to deleteUser, which
    // would then fail for a reason that looks unrelated.
    for (const table of USER_TABLES) {
      const { error } = await admin.from(table).delete().eq('user_id', userId)
      if (error) {
        Sentry.captureException(error)
        return new Response(
          JSON.stringify({ error: `Could not remove your ${table.replace('_', ' ')}: ${error.message}` }),
          { status: 500 },
        )
      }
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(userId)

    if (deleteError) {
      Sentry.captureException(deleteError)
      return new Response(
        JSON.stringify({ error: deleteError.message || 'Could not delete the account.' }),
        { status: 500 },
      )
    }

    return new Response(JSON.stringify({
      success: true,
      // Surfaced so DangerZoneSection could log/report it if it ever wants
      // to - the account is fully deleted either way, this is purely
      // informational about leftover storage objects.
      ...(screenshotFailures.length > 0 && { screenshotCleanupWarning: screenshotFailures.join('; ') }),
    }), { status: 200 })
  } catch (err) {
    // Anything unexpected (a thrown exception rather than a returned
    // {error}) would otherwise crash the route and hand the client a
    // non-JSON body, which is indistinguishable from every other failure
    // once it gets to DangerZoneSection's generic fallback message. Surface
    // whatever actually happened instead.
    Sentry.captureException(err)
    return new Response(
      JSON.stringify({ error: err?.message || 'Could not delete the account.' }),
      { status: 500 },
    )
  }
}
