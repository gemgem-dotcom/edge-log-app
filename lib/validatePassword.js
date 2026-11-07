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

export const PASSWORD_REQUIREMENTS_TEXT =
  'Use at least 12 characters, or at least 10 with a mix of upper case, lower case, numbers and symbols.'

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
  if (classes < 3) return PASSWORD_REQUIREMENTS_TEXT

  return null
}
