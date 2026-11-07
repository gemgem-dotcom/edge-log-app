import { describe, it, expect } from 'vitest'
import { validatePassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from './validatePassword'

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
    expect(validatePassword('Journeys-Through-Time', { email: 'jo@example.com' })).toBeNull()
  })
})

describe('validatePassword - what the old rule wrongly blocked', () => {
  // The 15-character cap blocked exactly the passwords worth having.
  it('accepts a long passphrase', () => {
    expect(validatePassword('correct horse battery staple')).toBeNull()
  })
  it('accepts a password-manager string well over the old cap', () => {
    expect(validatePassword('xK9#mQ2$vL7!pR4&wN8^zT5%yB3@')).toBeNull()
  })
  it('accepts symbols the old allowlist rejected', () => {
    expect(validatePassword('tra(de)~jour|nal_2026')).toBeNull()
  })
  it('still caps at something, so a megabyte never reaches the hash', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/fewer/)
    expect(validatePassword(`Aa1!${'x'.repeat(PASSWORD_MAX_LENGTH - 4)}`)).toBeNull()
  })
})

describe('validatePassword - the two routes to acceptance', () => {
  it('length alone is enough at 12 or more', () => {
    expect(validatePassword('abcdefghijkl')).toBeNull()
  })
  it('below 12, three of four character classes are needed', () => {
    expect(validatePassword('abcdefghij')).toBeTruthy()      // one class
    expect(validatePassword('abcdefghi1')).toBeTruthy()      // two classes
    expect(validatePassword('Abcdefghi1')).toBeNull()        // three
    expect(validatePassword('Abcdefgh1!')).toBeNull()        // four
  })
  it('enforces the floor', () => {
    expect(validatePassword('Ab1!efgh')).toMatch(new RegExp(String(PASSWORD_MIN_LENGTH)))
    expect(PASSWORD_MIN_LENGTH).toBe(10)
  })
})

describe('validatePassword - edges', () => {
  it('handles nothing without throwing', () => {
    for (const bad of [undefined, null, '']) expect(validatePassword(bad)).toBeTruthy()
  })
  it('does not throw when no email is supplied', () => {
    expect(() => validatePassword('correct horse battery staple')).not.toThrow()
    expect(validatePassword('correct horse battery staple', {})).toBeNull()
  })
})
