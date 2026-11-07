import { describe, it, expect, vi } from 'vitest'

// The module reaches for the browser Supabase client at import time (it
// subscribes to onAuthStateChange to empty the signed-URL cache on sign
// out), so that is stubbed. Nothing below touches it: isStoragePath is a
// pure predicate, which is the point of testing it on its own.
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } },
}))

const { isStoragePath } = await import('./screenshots.js')

describe('isStoragePath', () => {
  it('accepts the real shape - a uid-prefixed path inside the bucket', () => {
    expect(isStoragePath('07e293de-686c-4d3a-94d6-32515e7ce278/1730000000-chart.png')).toBe(true)
    expect(isStoragePath('a/b/c-thumb.jpg')).toBe(true)
  })

  // The whole reason this function exists. `trades` is the caller's own
  // row under a `for all` policy, so these are values a user can write
  // for themselves; before this they went straight into an <img src>.
  it.each([
    ['http', 'http://attacker.example/beacon.png'],
    ['https', 'https://attacker.example/beacon.png'],
    ['protocol-relative', '//attacker.example/beacon.png'],
    ['data', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['javascript', 'javascript:alert(1)'],
    ['blob', 'blob:https://example.com/abc'],
    ['uppercase scheme', 'HTTPS://attacker.example/x.png'],
    ['mixed-case scheme', 'JaVaScRiPt:alert(1)'],
    ['scheme with +.-', 'my-app.v2+x:payload'],
    ['backslash', 'uid\\..\\..\\other'],
  ])('refuses %s', (_label, value) => {
    expect(isStoragePath(value)).toBe(false)
  })

  it('refuses anything that is not a non-empty string', () => {
    for (const v of ['', null, undefined, 0, 42, {}, [], true]) {
      expect(isStoragePath(v)).toBe(false)
    }
  })
})
