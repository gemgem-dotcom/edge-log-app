// Shared password rules for EdgeLog.
// Passwords must be 8-15 characters long and may only contain letters,
// numbers, and a limited set of special characters - this keeps sign up, the
// forgot-password reset flow, and the account settings password change
// form all enforcing the exact same rule.

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 15

// Only these special characters are allowed alongside letters and digits.
const PASSWORD_PATTERN = /^[A-Za-z0-9!@#$%^&*?]{8,15}$/

export const PASSWORD_REQUIREMENTS_TEXT =
    'Password must be 8-15 characters long and may only contain letters, numbers, and special characters (!@#$%^&*?).'

export function validatePassword(password) {
    if (!password || !PASSWORD_PATTERN.test(password)) {
          return PASSWORD_REQUIREMENTS_TEXT
    }
    return null
}
