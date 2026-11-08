import { describe, it, expect } from 'vitest'
import { displayNameOf, displayNameUpdate, DISPLAY_NAME_KEY } from './displayName'

const user = (meta) => ({ user_metadata: meta })

describe('displayNameOf', () => {
  it('prefers the chosen name over the provider one', () => {
    expect(displayNameOf(user({ display_name: 'Gem', full_name: 'Gemma Murray' }))).toBe('Gem')
  })

  // THE BUG, as a test. Google rewrites full_name on every OAuth sign-in.
  // The chosen name has to win no matter what the provider most recently
  // wrote, or the name silently reverts.
  it('still prefers it after Google overwrites full_name', () => {
    const afterGoogleSignIn = user({
      display_name: 'Gem',
      full_name: 'Gemma Murray',
      name: 'Gemma Murray',
      iss: 'https://accounts.google.com',
      sub: '1234',
      picture: 'https://example.com/p.png',
    })
    expect(displayNameOf(afterGoogleSignIn)).toBe('Gem')
  })

  // Nothing may break for an account that has never set one.
  it('falls back to the provider name when none is chosen', () => {
    expect(displayNameOf(user({ full_name: 'Gemma Murray' }))).toBe('Gemma Murray')
    expect(displayNameOf(user({ display_name: '  ', full_name: 'Gemma Murray' }))).toBe('Gemma Murray')
  })

  it('is empty, never undefined, when there is no name at all', () => {
    for (const u of [user({}), user(null), {}, null, undefined]) {
      expect(displayNameOf(u)).toBe('')
    }
  })

  it('ignores a non-string in either field', () => {
    expect(displayNameOf(user({ display_name: 42, full_name: 'Gemma Murray' }))).toBe('Gemma Murray')
    expect(displayNameOf(user({ display_name: 42, full_name: {} }))).toBe('')
  })

  it('trims', () => {
    expect(displayNameOf(user({ display_name: '  Gem  ' }))).toBe('Gem')
  })
})

describe('displayNameUpdate', () => {
  it('writes the chosen key, which is what makes it stick', () => {
    expect(displayNameUpdate('Gem')[DISPLAY_NAME_KEY]).toBe('Gem')
  })

  // Kept in step so anything outside this app reading the conventional
  // field still sees the right name.
  it('writes full_name too', () => {
    expect(displayNameUpdate('Gem')).toEqual({ display_name: 'Gem', full_name: 'Gem' })
  })

  it('trims and survives nothing', () => {
    expect(displayNameUpdate('  Gem  ')).toEqual({ display_name: 'Gem', full_name: 'Gem' })
    expect(displayNameUpdate('')).toEqual({ display_name: '', full_name: '' })
    expect(displayNameUpdate(null)).toEqual({ display_name: '', full_name: '' })
  })
})
