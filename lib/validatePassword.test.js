import { describe, it, expect } from 'vitest'
import {
  validatePassword, missingClasses,
  PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_RULES_TOOLTIP,
} from './validatePassword'

describe('validatePassword - what the old rule let through', () => {
  // Every one of these passed the previous /^[A-Za-z0-9!@#$%^&*?]{8,15}$/.
  it('rejects the obvious ones', () => {
    for (const bad of ['password', 'trader11', 'aaaaaaaa', '12345678', 'Passw0rd']) {
      expect(validatePassword(bad)).toBeTruthy()
    }
  })
  it("rejects a password built from the user's own email", () => {
    expect(validatePassword('gemmamurray99', { email: 'gemmamurray@example.com' })).toMatch(/email/i)
  })
  it('does not treat a short local part as a substring to ban', () => {
    // "jo" appearing inside an unrelated password should not block it.
    expect(validatePassword('Journeys-Through-Time1', { email: 'jo@example.com' })).toBeNull()
  })
})

describe('validatePassword - what the old rule wrongly blocked', () => {
  // The 15-character cap blocked exactly the passwords worth having.
  // A passphrase is still welcome and still uncapped - but it has to
  // carry the four classes now, which a bare one does not. The
  // refusal of the bare form is asserted on its own below.
  it('accepts a long passphrase that carries the four classes', () => {
    expect(validatePassword('Correct-Horse-Battery-Staple-9')).toBeNull()
  })
  it('accepts a password-manager string well over the old cap', () => {
    expect(validatePassword('xK9#mQ2$vL7!pR4&wN8^zT5%yB3@')).toBeNull()
  })
  it('accepts symbols the old allowlist rejected', () => {
    expect(validatePassword('Tra(de)~jour|nal_2026')).toBeNull()
  })
  it('still caps at something, so a megabyte never reaches the hash', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/fewer/)
    expect(validatePassword(`Aa1!${'x'.repeat(PASSWORD_MAX_LENGTH - 4)}`)).toBeNull()
  })
})

describe('validatePassword - one rule: 12+ and all four classes', () => {
  it('accepts 12 with all four classes', () => {
    expect(validatePassword('Abcdefghi1!x')).toBeNull()
  })
  it('enforces the floor at 12', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12)
    // Eleven characters with all four classes is still refused: the
    // length check runs first and names the length.
    expect(validatePassword('Abcdefgh1!x')).toMatch(/12/)
  })
  // Length alone USED to be enough at 12. It is not any more, and this
  // is the case that proves it rather than leaving it to the comment.
  it('refuses a long passphrase with no number, capital or symbol', () => {
    expect(validatePassword('correct horse battery staple')).toBeTruthy()
  })
  it('names what is missing, not the whole rule', () => {
    expect(validatePassword('abcdefghijklmn'))
      .toBe('Add an uppercase letter, a number and a symbol.')
    expect(validatePassword('Abcdefghijklmn')).toBe('Add a number and a symbol.')
    expect(validatePassword('Abcdefghijkl1')).toBe('Add a symbol.')
  })
  it('missingClasses reports each class independently', () => {
    expect(missingClasses('Aa1!')).toEqual([])
    expect(missingClasses('aaaa')).toEqual(['an uppercase letter', 'a number', 'a symbol'])
    expect(missingClasses('')).toEqual(['an uppercase letter', 'a lowercase letter', 'a number', 'a symbol'])
  })
})

describe('the text the user reads', () => {
  it('the tooltip is the full requirement in one sentence', () => {
    expect(PASSWORD_RULES_TOOLTIP).toBe(
      'A strong password should be at least 12 to 16 characters long and combine '
      + 'uppercase and lowercase letters, numbers, and special symbols.',
    )
  })
  // "12 to 16" is advice about a good length, not a cap. Capping at 16
  // would block generated passphrases and password managers, which is
  // exactly the bug the old 8-15 rule had.
  it('does NOT cap length at 16', () => {
    expect(PASSWORD_MAX_LENGTH).toBe(128)
    expect(validatePassword(`Aa1!${'x'.repeat(28)}`)).toBeNull()
  })
})

describe('validatePassword - edges', () => {
  it('handles nothing without throwing', () => {
    for (const bad of [undefined, null, '']) expect(validatePassword(bad)).toBeTruthy()
  })
  it('does not throw when no email is supplied', () => {
    expect(() => validatePassword('Correct-Horse-Battery-9!')).not.toThrow()
    expect(validatePassword('Correct-Horse-Battery-9!', {})).toBeNull()
  })
})
