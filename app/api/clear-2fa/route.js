import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { decodeJwtClaims, isRecoverySession } from '@/lib/authAssurance'

// Removes every authenticator from an account, so that a completed
// password reset is a way back in rather than a dead end.
//
// THIS IS THE MOST DANGEROUS ROUTE IN THE APP. It switches two-factor
// authentication off. Everything below exists to make sure only one
// specific situation can reach it.
//
// WHY IT EXISTS AT ALL. EdgeLog deliberately has no recovery codes -
// they are a lot of machinery to put in front of someone who is not
// technical, and most of them are lost before they are ever needed. The
// cost of that choice is that /reset-password becomes the only way back
// into an account whose authenticator is gone, and that only works if
// finishing the reset also clears the factor. Otherwise the user sets a
// new password, is immediately asked for a code they cannot produce,
// and is locked out permanently by the flow meant to rescue them.
//
// WHY IT CANNOT BE DONE IN THE BROWSER. Supabase requires aal2 to
// unenroll a factor, and a recovery session is aal1 by construction -
// no code was ever presented. The user therefore cannot remove their
// own factor, which is the entire problem. Only the service role can,
// and the service role may never go near a browser.
//
// WHAT IT IS GATED ON, in order:
//
//   1. A bearer token that the auth server itself validates.
//   2. The session must be aal1. An aal2 session has already proved it
//      holds the factor and has no business here - it can unenroll
//      directly from Account settings, where the user is warned
//      properly and nothing is silently removed.
//   3. The session's amr must be EXACTLY the recovery method and
//      nothing else. This is the load-bearing check, and the reason the
//      route is safe: it is what stops somebody who merely stole a
//      password from calling it. A password sign-in reports `password`;
//      a Google sign-in reports `oauth`. Neither can reach this.
//
// The amr value is measured, not assumed - scripts/probe-recovery-session.js
// mints a real recovery session against this project's auth server and
// prints the claim. See RECOVERY_AMR_METHODS below.

function deny(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(req) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return deny(401, 'Not authenticated')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    // Fail closed and loudly. A misconfigured deployment must not turn
    // into "2FA quietly stopped being removable" discovered by a user.
    Sentry.captureException(new Error('clear-2fa: Supabase service credentials are not configured'))
    return deny(500, 'Server is not configured')
  }
  const admin = createClient(supabaseUrl, serviceKey)

  // getUser(token) revalidates against the auth server. Nothing below
  // trusts the token's contents until this has passed.
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  const user = userData?.user
  if (userError || !user) return deny(401, 'Invalid session')

  const claims = decodeJwtClaims(token)
  if (!claims) return deny(401, 'Invalid session')

  // The gate, in one call so that it is testable and so that there is
  // exactly one definition of it - see lib/authAssurance.js, where the
  // measured claim values and every refused case are written down.
  if (!isRecoverySession(claims)) {
    return deny(403, 'This can only be done while completing a password reset')
  }

  const { data: factorData, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: user.id })
  if (listError) {
    Sentry.captureException(listError)
    return deny(500, 'Could not read your authenticators')
  }

  // Idempotent on purpose. /reset-password calls this after changing the
  // password, so a user whose first attempt failed partway can simply
  // request another link and run it again - and an account with nothing
  // to remove is a success, not an error.
  const factors = factorData?.factors || []
  const failures = []
  for (const factor of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ userId: user.id, id: factor.id })
    if (error) failures.push(error.message)
  }

  if (failures.length) {
    Sentry.captureException(new Error(`clear-2fa: ${failures.length} factor(s) not removed: ${failures.join('; ')}`))
    return deny(500, 'Could not remove your authenticators')
  }

  // Revoke the recovery session itself. It has just been used for the
  // one thing it exists to do, and leaving it live means the same
  // cookies can call this route again later. Best effort: the factors
  // are already gone, and failing the recovery over a sign-out would
  // strand the user for no gain.
  try {
    await admin.auth.admin.signOut(user.id, 'global')
  } catch (err) {
    Sentry.captureException(err)
  }

  // Forget every remembered browser too. A trusted-device row is a
  // standing permission to skip a challenge; once the factors it was
  // granted against are gone, it is a permission to skip nothing,
  // and leaving it would let a browser trusted under the old setup
  // sail past whatever gets enrolled next. Best effort - the factors
  // are already gone, and failing the whole recovery over a stale row
  // would strand the user for no gain.
  const { error: trustError } = await admin
    .from('mfa_trusted_device')
    .delete()
    .eq('user_id', user.id)
  if (trustError) Sentry.captureException(trustError)

  // And the assurance grants, for the same reason: a grant lets an
  // aal1 session read rows, and the factors it was granted against
  // have just been removed.
  const { error: grantError } = await admin
    .from('mfa_assurance_grant')
    .delete()
    .eq('user_id', user.id)
  if (grantError) Sentry.captureException(grantError)

  return new Response(JSON.stringify({ success: true, removed: factors.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
