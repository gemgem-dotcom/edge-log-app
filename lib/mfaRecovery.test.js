import { describe, it, expect } from 'vitest'
import {
  getRecoveryStatus, generateRecoveryCodes, verifyRecoveryCode,
  isMissing, normaliseCode, recoveryAdvice, recoveryCodesFileBody,
  recoveryCodesFileName, LOW_WATERMARK,
} from './mfaRecovery'

// A stand-in for supabase.auth.mfa.recoveryCodes that can do the one
// thing the real experimental API does and nothing else in this codebase
// does: THROW instead of returning { data, error }.
const client = (impl) => ({ auth: { mfa: { recoveryCodes: impl } } })

describe('safely - the throwing API', () => {
  // The experimental methods throw when the client flag is off. An
  // unhandled throw in an event handler takes the whole panel down, so
  // every wrapper has to convert it.
  it('converts a thrown error into an error result instead of propagating', async () => {
    const c = client({ generate: async () => { throw new Error('recoveryCodes experimental flag is disabled') } })
    const { data, error } = await generateRecoveryCodes(c)
    expect(data).toBeNull()
    expect(error.thrown).toBe(true)
    expect(error.message).toMatch(/experimental/i)
  })
  it('passes a normal success straight through', async () => {
    const c = client({ generate: async () => ({ data: { codes: ['A', 'B'], total: 2 }, error: null }) })
    const { data } = await generateRecoveryCodes(c)
    expect(data.codes).toEqual(['A', 'B'])
  })
  it('survives a method that resolves to nothing at all', async () => {
    const c = client({ generate: async () => undefined })
    const { data, error } = await generateRecoveryCodes(c)
    expect(data).toBeNull()
    expect(error).toBeNull()
  })
})

describe('getRecoveryStatus', () => {
  it('reports the current set', async () => {
    const c = client({ getStatus: async () => ({ data: { total: 10, remaining: 7 }, error: null }) })
    const { status, error } = await getRecoveryStatus(c)
    expect(status.remaining).toBe(7)
    expect(error).toBeNull()
  })
  // "No codes yet" is the normal state of an account that never made
  // any. Rendering it as an error puts a red box on a panel that should
  // be inviting the user to act.
  it('treats "none exist" as an empty state, not an error', async () => {
    const c = client({ getStatus: async () => ({ data: null, error: { code: 'mfa_factor_not_found', message: 'not found' } }) })
    const { status, error } = await getRecoveryStatus(c)
    expect(status).toBeNull()
    expect(error).toBeNull()
  })
  it('still surfaces a real failure', async () => {
    const c = client({ getStatus: async () => ({ data: null, error: { code: 'internal', message: 'boom' } }) })
    const { error } = await getRecoveryStatus(c)
    expect(error.message).toBe('boom')
  })
})

describe('isMissing', () => {
  it('matches on the code and on the wording, since servers differ', () => {
    expect(isMissing({ code: 'mfa_factor_not_found' })).toBe(true)
    expect(isMissing({ message: 'No recovery codes found' })).toBe(true)
    expect(isMissing({ message: 'Factor not found' })).toBe(true)
  })
  it('does not swallow an unrelated failure', () => {
    expect(isMissing({ code: 'internal', message: 'database unavailable' })).toBe(false)
    expect(isMissing(null)).toBe(false)
  })
})

describe('normaliseCode', () => {
  it('uppercases and strips ordinary whitespace', () => {
    expect(normaliseCode('  abcd-1234  ')).toBe('ABCD-1234')
    expect(normaliseCode('ab cd 12 34')).toBe('ABCD1234')
  })
  // The invisible ones are the whole reason this exists: a code pasted
  // from a PDF or a web page can carry a non-breaking space or a
  // zero-width joiner, and the user staring at "invalid code" cannot see
  // any difference between that and a correct code.
  it('strips invisible characters a paste can carry', () => {
    expect(normaliseCode('ABCD 1234')).toBe('ABCD1234')
    expect(normaliseCode('ABCD​1234')).toBe('ABCD1234')
    expect(normaliseCode('﻿ABCD1234')).toBe('ABCD1234')
  })
  it('is safe on nothing', () => {
    expect(normaliseCode(null)).toBe('')
    expect(normaliseCode(undefined)).toBe('')
  })
})

describe('verifyRecoveryCode', () => {
  it('normalises before sending, so a pasted code is not rejected for whitespace', async () => {
    let seen = null
    const c = client({ verify: async ({ code }) => { seen = code; return { data: {}, error: null } } })
    await verifyRecoveryCode(c, '  abcd 1234 ')
    expect(seen).toBe('ABCD1234')
  })
})

describe('recoveryAdvice', () => {
  it('says nothing demanding while 2FA is off', () => {
    const a = recoveryAdvice(null, { twoFactorOn: false })
    expect(a.tone).toBe('off')
  })
  // The panel heading above this line already reads "Recovery codes", so
  // repeating it as the status line looked like a duplicated render.
  it('does not repeat the panel heading as its own title', () => {
    expect(recoveryAdvice(null, { twoFactorOn: false }).title).not.toBe('Recovery codes')
  })
  // The dangerous state: protection on, no way back in.
  it('is CRITICAL when 2FA is on and no codes exist', () => {
    const a = recoveryAdvice(null, { twoFactorOn: true })
    expect(a.tone).toBe('critical')
    expect(a.note).toMatch(/losing your authenticator means losing access/i)
  })
  it('is CRITICAL when every code has been spent', () => {
    expect(recoveryAdvice({ total: 10, remaining: 0 }, { twoFactorOn: true }).tone).toBe('critical')
  })
  it('warns before the user reaches zero, not at it', () => {
    expect(recoveryAdvice({ total: 10, remaining: LOW_WATERMARK }, { twoFactorOn: true }).tone).toBe('warn')
    expect(recoveryAdvice({ total: 10, remaining: LOW_WATERMARK + 1 }, { twoFactorOn: true }).tone).toBe('ok')
  })
  it('says how many are left, in both the healthy and the low state', () => {
    expect(recoveryAdvice({ total: 10, remaining: 7 }, { twoFactorOn: true }).title).toBe('7 of 10 codes left')
    expect(recoveryAdvice({ total: 10, remaining: 2 }, { twoFactorOn: true }).title).toBe('2 of 10 codes left')
  })
  // A tone, not a colour: this module has no business knowing the
  // palette, and a test can assert on 'critical' but not on a hex value.
  it('returns a tone rather than a colour', () => {
    for (const s of [null, { total: 10, remaining: 0 }, { total: 10, remaining: 2 }, { total: 10, remaining: 9 }]) {
      const a = recoveryAdvice(s, { twoFactorOn: true })
      expect(['off', 'ok', 'warn', 'critical']).toContain(a.tone)
      expect(JSON.stringify(a)).not.toMatch(/#[0-9a-f]{3,6}/i)
    }
  })
})

describe('the downloaded file', () => {
  const codes = ['AAAA-1111', 'BBBB-2222']

  it('contains every code', () => {
    const body = recoveryCodesFileBody(codes, { email: 'trader@example.com' })
    for (const c of codes) expect(body).toContain(c)
  })
  it('says which account it belongs to, so two files are tellable apart', () => {
    expect(recoveryCodesFileBody(codes, { email: 'a@b.c' })).toContain('a@b.c')
  })
  it('warns that the codes are as powerful as a password', () => {
    expect(recoveryCodesFileBody(codes)).toMatch(/treat them like passwords/i)
  })
  it('says each code works once', () => {
    expect(recoveryCodesFileBody(codes)).toMatch(/ONCE/)
  })
  it('does not fall over with no codes', () => {
    expect(() => recoveryCodesFileBody(null)).not.toThrow()
    expect(() => recoveryCodesFileBody(undefined)).not.toThrow()
  })
  it('names the file with the date so a second download does not overwrite silently', () => {
    expect(recoveryCodesFileName()).toMatch(/^edgelog-recovery-codes-\d{4}-\d{2}-\d{2}\.txt$/)
  })
})
