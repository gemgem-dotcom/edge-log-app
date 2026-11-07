// The decisions behind two-factor authentication, as pure functions.
//
// WHY THESE LEFT THE COMPONENTS. Every one of these was an inline
// expression in TwoFactorSection or the login page, which made them
// untestable: this repo deliberately has no React renderer (see
// CLAUDE.md's testing note), so logic living inside a component is logic
// nothing can assert on. For a login path that is the wrong trade. These
// are the rules that decide whether somebody gets into the account, and
// they should be the best-tested code in the repo, not the least.
//
// THE BUG THAT PROMPTED IT. Both call sites read `factors[0]`. With one
// factor that is correct and with two it is quietly wrong: the account
// page offered to remove only the first and the login page would only
// ever challenge the first, so a trader whose phone died could not use
// the tablet they had deliberately enrolled as a spare. Nothing errored.
// The second factor simply did not exist as far as the UI was concerned.

// Supabase groups factors by type and includes unverified ones - a factor
// is created unverified by enroll() and only becomes verified once a code
// has been checked against it. An unverified factor is an abandoned
// enrolment, never a usable second factor, so every "can this person log
// in" question filters on verified and every "is enrolment blocked"
// question looks at the rest.
export function verifiedFactors(data) {
  return (data?.totp || []).filter((f) => f?.status === 'verified')
}

export function unverifiedFactors(data) {
  return (data?.totp || []).filter((f) => f && f.status !== 'verified')
}

export function hasVerifiedFactor(data) {
  return verifiedFactors(data).length > 0
}

// Does this session still owe a second factor?
//
// The test is on the ASSURANCE LEVEL, not on whether factors exist, and
// the difference matters. `nextLevel` is aal2 when the account has a
// verified factor; `currentLevel` is aal2 once this session has actually
// satisfied one. Gating on "does the user have a factor" instead would
// re-challenge somebody who had already passed it moments earlier - the
// classic version of this bug, which locks a user in a loop they cannot
// escape because every correct code sends them back to the start.
export function needsSecondFactor(aal) {
  if (!aal) return false
  return aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2'
}

// Which factor to challenge when the user has several.
//
// Deliberately the most recently USED one rather than the first enrolled:
// somebody with a phone and a spare tablet reaches for the phone almost
// every time, and `last_challenged_at` is the only evidence of that the
// server gives us. Falls back to the oldest enrolment, which is the one
// most likely to be the everyday device for an account that has never
// recorded a challenge.
export function preferredFactor(data) {
  const verified = verifiedFactors(data)
  if (verified.length === 0) return null
  const used = verified
    .filter((f) => f.last_challenged_at)
    .sort((a, b) => Date.parse(b.last_challenged_at) - Date.parse(a.last_challenged_at))
  if (used.length) return used[0]
  return verified
    .slice()
    .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0))[0]
}

// A label for a factor that has no friendly name.
//
// Factors enrolled before names were asked for have `friendly_name`
// undefined, and rendering an empty string leaves a row with a Remove
// button and nothing saying what it removes. The created date is the only
// distinguishing thing we hold for such a factor, so it becomes the name.
export function factorLabel(factor) {
  if (factor?.friendly_name) return factor.friendly_name
  const at = Date.parse(factor?.created_at)
  if (!Number.isFinite(at)) return 'Authenticator app'
  return `Authenticator added ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

// Supabase rejects an enrolment whose friendly name collides with an
// existing factor, and that refusal arrives as an opaque failure in the
// middle of a QR screen. Suggesting a name that is already free avoids
// walking the user into it.
export function suggestFactorName(data, base = 'Authenticator') {
  const taken = new Set((data?.totp || []).map((f) => f?.friendly_name).filter(Boolean))
  if (!taken.has(base)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate)) return candidate
  }
  // A hundred authenticators is not a real account, but returning
  // undefined here would hand Supabase a name collision instead.
  return `${base} ${Date.now()}`
}

// Is this name usable for a new factor?
//
// Checked before the enrolment call rather than after, so the user is
// told by the field they typed into rather than by a failure on the
// screen that follows it.
export function validateFactorName(name, data) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return 'Give this device a name so you can tell it apart later.'
  if (trimmed.length > 60) return 'That name is too long - 60 characters at most.'
  const taken = (data?.totp || []).some(
    (f) => f?.friendly_name && f.friendly_name.toLowerCase() === trimmed.toLowerCase(),
  )
  if (taken) return 'You already have a device with that name.'
  return null
}

// REMOVING THE LAST FACTOR IS NOT THE SAME ACTION AS REMOVING ONE OF
// SEVERAL, and the UI has to say so differently. Taking one of three
// devices off the account leaves two-factor authentication fully on;
// taking the only one off turns the protection off entirely. The same
// confirmation wording for both either over-warns about a routine tidy-up
// or under-warns about a security downgrade.
export function isLastFactor(data, factorId) {
  const verified = verifiedFactors(data)
  return verified.length === 1 && verified[0]?.id === factorId
}
