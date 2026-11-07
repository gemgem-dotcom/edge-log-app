// Shared password rules for EdgeLog - signup, the forgot-password reset
// flow, and the account settings password change all enforce this one
// function.
//
// WHAT CHANGED AND WHY. The rule used to be
// /^[A-Za-z0-9!@#$%^&*?]{8,15}$/, which had two problems in one line.
//
// It accepted `password`, `trader11` and `aaaaaaaa` - no complexity
// requirement of any kind, no check against the user's own email.
//
// And it CAPPED length at 15 and the charset at a handful of symbols,
// which blocks a generated passphrase and most password managers'
// defaults, pushing people back toward exactly the short memorable
// strings the first problem already permitted. A maximum length is not
// a security control: Supabase bcrypts the password, so length costs
// nothing. The only real reason for an upper bound is to stop a
// megabyte of input reaching the hash, which 128 handles.
//
// That mattered more here than it usually would, because EdgeLog
// measured NO server-side rate limiting on auth verification
// (scripts/probe-auth-rate-limits.js, 2026-11-07: twenty failing
// attempts from one IP, no 429). Whether the password grant is limited
// is a separate question nothing in this repo has measured, so the
// conservative assumption is that an eight-lowercase-character space
// is remotely brute-forceable.
//
// EXISTING PASSWORDS ARE UNAFFECTED. This only runs when somebody
// types a NEW password; it is not re-validated at sign-in.

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

// ONE RULE NOW: at least 12 characters, and all four character classes.
//
// This replaced a two-branch rule (12+ on length alone, or 10+ with
// three of four classes). The branch structure was what made the old
// wording so hard to state in a sentence, and it is gone.
//
// The trade, recorded rather than hidden: requiring all four classes at
// every length rejects a long passphrase. "correct horse battery
// staple" is 28 characters and genuinely strong, and it fails this,
// while "Passw0rd!123" passes at 12. Length buys more entropy than
// class variety does. This is a deliberate choice to state one simple
// requirement everybody already recognises over a rule that is stronger
// on paper and confusing to read - and the minimum went UP from 10 to
// 12 in the same move, which is where most of the real strength is.
//
// The maximum stays 128, NOT 16. "12 to 16" is advice about a good
// length, not a cap: capping at 16 would block generated passphrases
// and most password managers' defaults, which is precisely the bug
// the 8-15 rule had.

// WHAT THE USER READS. One sentence, the whole requirement, in the "?"
// beside the field and nowhere else on Account settings.
export const PASSWORD_RULES_TOOLTIP =
  'A strong password should be at least 12 to 16 characters long and combine '
  + 'uppercase and lowercase letters, numbers, and special symbols.'

// The visible one-liner for signup and the reset form - the two places
// somebody picks a password for the FIRST time, where hiding the rule
// behind something you have to find is how a new user ends up trying
// four variations of a password they were never going to be allowed.
export const PASSWORD_HINT_SHORT =
  'At least 12 characters, with uppercase, lowercase, numbers and symbols.'

// Anything a keyboard produces. The old allowlist rejected perfectly
// good characters and bought nothing - the value is hashed, never
// interpolated into anything.
const PRINTABLE = /^[\x20-\x7E]+$/

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'letmein1', 'welcome1', 'iloveyou', 'admin123', 'trading1',
  'changeme', 'passw0rd', 'football1', 'sunshine1', 'princess1', 'edgelog1',
])

// Name what is actually missing rather than reprinting the whole rule.
// Somebody who typed fourteen lowercase letters needs to be told to add
// a capital, a number and a symbol - not read the requirements again
// and work out for themselves which part they failed.
const CLASSES = [
  { label: 'an uppercase letter', test: /[A-Z]/ },
  { label: 'a lowercase letter', test: /[a-z]/ },
  { label: 'a number', test: /[0-9]/ },
  { label: 'a symbol', test: /[^A-Za-z0-9]/ },
]

export function missingClasses(password) {
  return CLASSES.filter((c) => !c.test.test(String(password || ''))).map((c) => c.label)
}

function listOut(items) {
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function validatePassword(password, { email } = {}) {
  if (!password) return 'Enter a password.'
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`
  }
  if (!PRINTABLE.test(password)) {
    return 'Password can only contain ordinary keyboard characters.'
  }
  if (COMMON.has(password.toLowerCase())) {
    return 'That password is too easy to guess. Please choose another.'
  }

  // The local part of their own email is the first thing anyone tries.
  const local = String(email || '').split('@')[0].toLowerCase()
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    return "Password can't contain your email address."
  }

  const missing = missingClasses(password)
  if (missing.length) return `Add ${listOut(missing)}.`

  return null
}
