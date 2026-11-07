import { describe, it, expect, vi, beforeEach } from 'vitest'

// Integration cover for app/api/record-login's branching, which is where
// the "missing work laptop" bug lived. The decision it makes - update this
// browser's row, adopt one legacy row, or insert a new one - is not
// visible from any pure function, so it is driven here against a stubbed
// client rather than left untested.

const calls = []
let adoptableRows = []

const table = () => {
  const q = {
    _filters: {},
    select() { return q },
    eq(col, val) { q._filters[col] = val; return q },
    is(col, val) { q._filters[col] = val; return q },
    order() { return q },
    limit() { return Promise.resolve({ data: adoptableRows, error: null }) },
    upsert(row, opts) { calls.push({ kind: 'upsert', row, opts }); return Promise.resolve({ error: null }) },
    insert(row) { calls.push({ kind: 'insert', row }); return Promise.resolve({ error: null }) },
    update(row) {
      calls.push({ kind: 'update', row, filters: q._filters })
      return { eq: (c, v) => { calls[calls.length - 1].filters[c] = v; return Promise.resolve({ error: null }) } }
    },
  }
  return q
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: () => table(),
  }),
}))
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }))
vi.mock('@/lib/authAssurance', () => ({ serviceRouteNeedsSecondFactor: async () => false }))

const { POST } = await import('../app/api/record-login/route.js')

const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36'

function request({ cookie } = {}) {
  const headers = new Map([
    ['authorization', 'Bearer t'],
    ['user-agent', WINDOWS_CHROME],
  ])
  if (cookie) headers.set('cookie', cookie)
  return { headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } }
}

beforeEach(() => {
  calls.length = 0
  adoptableRows = []
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'
})

describe('record-login: one row per browser', () => {
  it('a known browser updates its own row, keyed on device_id', async () => {
    const id = 'a'.repeat(32)
    const res = await POST(request({ cookie: `edgelog_did=${id}` }))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('upsert')
    expect(calls[0].opts.onConflict).toBe('user_id,device_id')
    expect(calls[0].row.device_id).toBe(id)
    // It must NOT re-issue a cookie it already has.
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  // THE BUG. Two different Windows+Chrome machines share a device_key.
  // Before this change the second overwrote the first and vanished.
  it('a second Windows+Chrome machine gets its OWN row, not the first one', async () => {
    const first = 'a'.repeat(32)
    const second = 'b'.repeat(32)
    await POST(request({ cookie: `edgelog_did=${first}` }))
    await POST(request({ cookie: `edgelog_did=${second}` }))

    expect(calls).toHaveLength(2)
    expect(calls[0].row.device_key).toBe(calls[1].row.device_key)   // same class...
    expect(calls[0].row.device_id).not.toBe(calls[1].row.device_id) // ...different browser
  })

  it('an unseen browser with no legacy row inserts, and is given a cookie', async () => {
    const res = await POST(request())
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('insert')
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toMatch(/^edgelog_did=[0-9a-f]{32};/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('an unseen browser adopts ONE unclaimed legacy row of its own class', async () => {
    adoptableRows = [{ id: 'legacy-1' }]
    await POST(request())
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('update')
    expect(calls[0].filters.id).toBe('legacy-1')
    expect(calls[0].row.device_id).toMatch(/^[0-9a-f]{32}$/)
  })

  // A forged or corrupt cookie must not reach the unique index.
  it('treats a malformed cookie as no cookie, and mints a fresh id', async () => {
    const res = await POST(request({ cookie: "edgelog_did=' or 1=1 --" }))
    expect(calls[0].kind).toBe('insert')
    expect(calls[0].row.device_id).toMatch(/^[0-9a-f]{32}$/)
    expect(res.headers.get('set-cookie')).toMatch(/^edgelog_did=[0-9a-f]{32};/)
  })

  it('never writes on an unassured caller', async () => {
    vi.resetModules()
    vi.doMock('@/lib/authAssurance', () => ({ serviceRouteNeedsSecondFactor: async () => true }))
    const { POST: GATED } = await import('../app/api/record-login/route.js')
    const res = await GATED(request())
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
