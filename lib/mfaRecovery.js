// Recovery codes: the way back into an account whose authenticator is
// gone.
//
// WHY THIS IS THE MOST IMPORTANT PIECE OF THE WHOLE 2FA FEATURE. Without
// it, turning on two-factor authentication quietly converts "I lost my
// phone" into "I lost my account". There is no self-service way back:
// the only fix is an administrator deleting the factor out of the
// Supabase dashboard, which does not scale past a handful of users and
// is not available at all to someone using this at 2am. Every other
// hardening measure here protects the account from an attacker. This one
// protects it from its own owner's bad luck, which is far more common.
//
// WRAPPED RATHER THAN CALLED DIRECTLY. supabase.auth.mfa.recoveryCodes.*
// is experimental in the SDK: the methods THROW when the client's
// experimental.recoveryCodes flag is off, and the shape may change in a
// minor release. Keeping every call behind this module means one place
// to fix when it moves, and - more usefully - one place that converts a
// thrown error into the `{ data, error }` shape the rest of the app
// already knows how to handle.

// How low "running out" is. Ten codes are issued; at two remaining the
// account is one bad week from being locked out, and the user should be
// told before they get there rather than at zero.
export const LOW_WATERMARK = 3

// Every recoveryCodes call can throw rather than return, which no other
// Supabase call in this app does. An unhandled throw inside an event
// handler takes the whole panel down, so this normalises it.
async function safely(fn) {
  try {
    const result = await fn()
    return result || { data: null, error: null }
  } catch (err) {
    return { data: null, error: { message: err?.message || 'Recovery codes are unavailable.', thrown: true } }
  }
}

export async function getRecoveryStatus(client) {
  const { data, error } = await safely(() => client.auth.mfa.recoveryCodes.getStatus())
  // "No recovery codes found" is not a failure - it is the normal state
  // of an account that has never generated any, and it must render as an
  // invitation rather than an error.
  if (error) return { status: null, error: isMissing(error) ? null : error }
  return { status: data, error: null }
}

export async function generateRecoveryCodes(client) {
  return safely(() => client.auth.mfa.recoveryCodes.generate())
}

export async function regenerateRecoveryCodes(client) {
  return safely(() => client.auth.mfa.recoveryCodes.regenerate())
}

export async function verifyRecoveryCode(client, code) {
  return safely(() => client.auth.mfa.recoveryCodes.verify({ code: normaliseCode(code) }))
}

// "This account has none" rather than "something went wrong". Matched on
// the code where the server gives one and on the message otherwise,
// because the two servers in play (real and mock) word it differently
// and a missed match turns an empty state into a red error box.
export function isMissing(error) {
  if (!error) return false
  if (error.code === 'mfa_factor_not_found') return true
  return /not\s*found|no recovery codes/i.test(error.message || '')
}

// Users paste recovery codes out of password managers, text files and
// screenshots, so they arrive with stray whitespace, soft hyphens and
// inconsistent case. Normalising here rather than at each call site
// means the login box and the account panel cannot disagree about what
// counts as the same code.
export function normaliseCode(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    // A pasted code can carry a non-breaking space or a zero-width
    // character from a PDF or a web page; neither is visible to the user
    // staring at an "invalid code" message.
    .replace(/[\s ​-‍﻿]+/g, '')
}

// What the panel should say about the codes it has.
//
// Returns a `tone` rather than a colour so the component picks the token:
// this module has no business knowing the app's palette, and a test can
// assert on 'critical' where it cannot assert on a hex value.
export function recoveryAdvice(status, { twoFactorOn } = {}) {
  if (!twoFactorOn) {
    // Not "Recovery codes": the panel heading directly above already says
    // that, and the two together read as a rendering fault. "Not set up"
    // also matches the wording the two-factor block above uses for the
    // same idea ("Not enabled"), so the two off-states look deliberate.
    return { tone: 'off', title: 'Not set up', note: 'Available once two-factor authentication is on.' }
  }
  if (!status) {
    return {
      tone: 'critical',
      title: 'No recovery codes',
      note: 'Without these, losing your authenticator means losing access to this account. Generate them now and keep them somewhere safe.',
    }
  }
  const { remaining = 0, total = 0 } = status
  if (remaining === 0) {
    return {
      tone: 'critical',
      title: 'All codes used',
      note: 'Every recovery code has been used. Generate a new set now - you currently have no way back in if you lose your authenticator.',
    }
  }
  if (remaining <= LOW_WATERMARK) {
    return {
      tone: 'warn',
      title: `${remaining} of ${total} codes left`,
      note: 'Running low. Generate a new set soon - the old codes stop working when you do.',
    }
  }
  return {
    tone: 'ok',
    title: `${remaining} of ${total} codes left`,
    note: 'Each code works once. Keep them somewhere you can reach without this account.',
  }
}

// The file a user downloads. Plain text on purpose: it has to be
// readable on a machine that has lost access to everything else, which
// rules out anything needing an app to open it.
export function recoveryCodesFileBody(codes, { appName = 'EdgeLog', email } = {}) {
  const when = new Date().toISOString().slice(0, 10)
  return [
    `${appName} recovery codes`,
    email ? `Account: ${email}` : null,
    `Generated: ${when}`,
    '',
    'Each code can be used ONCE to sign in if you cannot reach your',
    'authenticator app. Keep this file somewhere you can get to without',
    'logging in - a password manager, or printed and stored safely.',
    '',
    'Anyone holding these codes can get past two-factor authentication.',
    'Treat them like passwords.',
    '',
    ...(codes || []).map((c) => `  ${c}`),
    '',
  ].filter((l) => l !== null).join('\n')
}

export function recoveryCodesFileName({ appName = 'EdgeLog' } = {}) {
  return `${appName.toLowerCase()}-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`
}
