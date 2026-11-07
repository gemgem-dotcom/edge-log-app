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

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 128

// Twelve or more is accepted on length alone - that is the passphrase
// case, and a long passphrase is stronger than a short string with a
// digit bolted on. Below that, three of four character classes.
const PASSPHRASE_LENGTH = 12

// WHAT THE USER READS, and why it is not the rule restated.
//
// The rule has two branches, and the old single sentence tried to carry
// both at once: "Use at least 12 characters, or at least 10 with a mix
// of upper case, lower case, numbers and symbols." Every word of that
// is true and it is still hard to act on - two thresholds, an "or", and
// a four-item list, read by somebody who only wants to know what to
// type. Nobody reading it learns the one thing that would get them
// through: make it longer and none of the rest applies.
//
// So the branches are split by WHEN they are useful. The tooltip leads
// with the easy branch and mentions the other second. The error is only
// ever seen by somebody already in the short branch, so it tells that
// person what to do rather than re-describing the whole policy.
export const PASSWORD_RULES_TOOLTIP =
  'Twelve characters or more is all you need - three or four words in a row '
  + 'is an easy way to get there. Ten or eleven works too, but then it has to '
  + 'mix capitals, lower case, numbers and symbols.'

// The one-line version, for the two places somebody is choosing a
// password for the FIRST time - signup and the reset form. Those pages
// keep a visible hint rather than a "?": hiding the rule behind
// something you have to find is how a new user ends up trying four
// variations of a password they were never going to be allowed, which
// is the exact fault a previous change fixed by putting the text there.
// Account settings is different - that user already has a password, the
// field sits in a row of three, and the small print cost more than it
// gave.
//
// It states only the branch that always works. Nobody needs the second
// branch to succeed, and the error below teaches it to the only person
// it helps.
export const PASSWORD_HINT_SHORT =
  'Use 12 characters or more - a few words in a row works well.'

export const PASSWORD_TOO_SIMPLE =
  'Mix in capitals, numbers and symbols - or make it 12 characters or longer, '
  + 'which needs none of that.'

// Anything a keyboard produces. The old allowlist rejected perfectly
// good characters and bought nothing - the value is hashed, never
// interpolated into anything.
const PRINTABLE = /^[\x20-\x7E]+$/

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'letmein1', 'welcome1', 'iloveyou', 'admin123', 'trading1',
  'changeme', 'passw0rd', 'football1', 'sunshine1', 'princess1', 'edgelog1',
])

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

  if (password.length >= PASSPHRASE_LENGTH) return null

  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0)
  if (classes < 3) return PASSWORD_TOO_SIMPLE

  return null
}
