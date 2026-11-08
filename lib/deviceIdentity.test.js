import { describe, it, expect } from 'vitest'
import {
  readDeviceId, mintDeviceId, deviceIdCookie,
  DEVICE_ID_COOKIE, DEVICE_ID_MAX_AGE_SEC,
} from './deviceIdentity'

describe('mintDeviceId', () => {
  it('is 32 hex characters', () => {
    expect(mintDeviceId()).toMatch(/^[0-9a-f]{32}$/)
  })
  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintDeviceId()))
    expect(seen.size).toBe(200)
  })
})

describe('readDeviceId', () => {
  it('finds the cookie among others', () => {
    const id = mintDeviceId()
    expect(readDeviceId(`theme=dark; ${DEVICE_ID_COOKIE}=${id}; edgelog_td=abc`)).toBe(id)
    expect(readDeviceId(`${DEVICE_ID_COOKIE}=${id}`)).toBe(id)
  })

  it('is absent rather than wrong when there is no cookie', () => {
    for (const header of ['', null, undefined, 'theme=dark', 'edgelog_td=abc']) {
      expect(readDeviceId(header)).toBeNull()
    }
  })

  // The value reaches a unique index and sits beside a nickname the user
  // reads. Anything not the shape we mint is treated as absent, which
  // makes the route mint a fresh one rather than store the input.
  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(33)],
    ['uppercase hex', 'A'.repeat(32)],
    ['non-hex', 'g'.repeat(32)],
    ['sql-ish', "' or 1=1 --"],
    ['empty value', ''],
  ])('refuses %s', (_label, value) => {
    expect(readDeviceId(`${DEVICE_ID_COOKIE}=${value}`)).toBeNull()
  })

  it('is not fooled by a cookie whose name merely ends with ours', () => {
    const id = mintDeviceId()
    expect(readDeviceId(`not_${DEVICE_ID_COOKIE}=${id}`)).toBeNull()
  })
})

describe('deviceIdCookie', () => {
  const id = 'a'.repeat(32)

  it('is httpOnly, lax and path-wide', () => {
    const c = deviceIdCookie(id, { secure: true })
    expect(c).toContain(`${DEVICE_ID_COOKIE}=${id}`)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/')
    expect(c).toContain(`Max-Age=${DEVICE_ID_MAX_AGE_SEC}`)
  })

  it('is Secure in production and not over plain http in dev', () => {
    expect(deviceIdCookie(id, { secure: true })).toContain('Secure')
    expect(deviceIdCookie(id, { secure: false })).not.toContain('Secure')
  })

  // A browser that quietly becomes a "new device" every few months fills
  // the list with duplicates of itself and teaches the owner to ignore
  // entries they do not recognise - the instinct the panel depends on.
  it('lasts years, not weeks', () => {
    expect(DEVICE_ID_MAX_AGE_SEC).toBeGreaterThan(365 * 24 * 60 * 60)
  })

  it('round-trips through readDeviceId', () => {
    const minted = mintDeviceId()
    const header = deviceIdCookie(minted).split(';')[0]
    expect(readDeviceId(header)).toBe(minted)
  })
})

// The device id is now the identity for BOTH lists - sign-in history and
// trusted devices. These pin the property the two depend on: the same
// browser keeps one id, and a browser that cannot keep a cookie is told
// apart rather than merged with someone else.
describe('shared identity for both device lists', () => {
  it('a browser that returns its cookie keeps the same id', () => {
    const id = mintDeviceId()
    const header = deviceIdCookie(id).split(';')[0]
    expect(readDeviceId(header)).toBe(id)
    expect(readDeviceId(header)).toBe(id)
  })

  it('a browser that loses its cookie is unidentified, never another browser', () => {
    // The caller mints a new id on null. It must never resolve to some
    // other browser's id, which is what collapsing on device CLASS did.
    expect(readDeviceId(null)).toBeNull()
    expect(mintDeviceId()).not.toBe(mintDeviceId())
  })
})
