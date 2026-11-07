import { describe, it, expect } from 'vitest'
import {
  spendVerdict, continuityFrom,
  MIN_INTERVAL_MS, MAX_CALLS_PER_DAY, MAX_CONTINUITY_CHARS,
} from './insightSpend'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const secsAgo = (s) => new Date(NOW - s * 1000).toISOString()
const call = (scope, s) => ({ scope, created_at: secsAgo(s) })
// The route records the attempt before judging it, so the row for THIS
// request is always present in what spendVerdict sees.
const withSelf = (scope, rest = []) => [call(scope, 0), ...rest]

describe('spendVerdict - the interval', () => {
  it('allows a first call', () => {
    expect(spendVerdict(withSelf('overall'), { scope: 'overall', now: NOW }).allowed).toBe(true)
  })
  // A request must not be judged too soon after itself. The row for
  // this call is already in the table by the time this runs.
  it('does not count the request being judged against itself', () => {
    expect(spendVerdict(withSelf('overall'), { scope: 'overall', now: NOW }).reason).toBeNull()
  })
  it('refuses a second call within the interval', () => {
    const v = spendVerdict(withSelf('overall', [call('overall', 10)]), { scope: 'overall', now: NOW })
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('interval')
    expect(v.message).toMatch(/wait \d+s/)
  })
  it('allows one after the interval has passed', () => {
    const v = spendVerdict(withSelf('overall', [call('overall', MIN_INTERVAL_MS / 1000 + 5)]), { scope: 'overall', now: NOW })
    expect(v.allowed).toBe(true)
  })
  it('scopes the interval, so a different scope is not blocked', () => {
    const v = spendVerdict(withSelf('instrument:a', [call('overall', 5)]), { scope: 'instrument:a', now: NOW })
    expect(v.allowed).toBe(true)
  })
})

describe('spendVerdict - the daily cap', () => {
  // The per-scope interval alone is multiplied by however many scopes
  // the caller invents, and they create their own instruments and
  // strategies. The cap is what makes that bounded.
  it('refuses once the account has spent its day', () => {
    const rows = Array.from({ length: MAX_CALLS_PER_DAY + 1 }, (_, i) => call(`instrument:${i}`, i * 120))
    const v = spendVerdict(rows, { scope: 'instrument:new', now: NOW })
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('daily')
  })
  it('allows right up to the cap', () => {
    const rows = Array.from({ length: MAX_CALLS_PER_DAY }, (_, i) => call(`instrument:${i}`, i * 120))
    expect(spendVerdict(rows, { scope: 'instrument:new', now: NOW }).allowed).toBe(true)
  })
  it('ignores calls older than a day', () => {
    const rows = Array.from({ length: MAX_CALLS_PER_DAY + 5 }, (_, i) => call(`instrument:${i}`, 25 * 3600 + i))
    expect(spendVerdict(withSelf('overall', rows), { scope: 'overall', now: NOW }).allowed).toBe(true)
  })
  it('the daily cap wins over the interval, and says so', () => {
    const rows = Array.from({ length: MAX_CALLS_PER_DAY + 1 }, (_, i) => call('overall', i))
    const v = spendVerdict(rows, { scope: 'overall', now: NOW })
    expect(v.reason).toBe('daily')
    expect(v.message).toMatch(/today/i)
  })
})

describe('spendVerdict - malformed input', () => {
  it('survives junk rows without throwing or miscounting', () => {
    const rows = [null, undefined, {}, { scope: 'overall', created_at: 'nope' }, call('overall', 0)]
    expect(() => spendVerdict(rows, { scope: 'overall', now: NOW })).not.toThrow()
    expect(spendVerdict(rows, { scope: 'overall', now: NOW }).allowed).toBe(true)
  })
  it('is safe on no rows at all', () => {
    expect(spendVerdict(null, { scope: 'overall', now: NOW }).allowed).toBe(true)
  })
})

describe('continuityFrom - the caller no longer writes the system prompt', () => {
  it('passes a stored narrative through', () => {
    expect(continuityFrom('Last time you traded well.')).toBe('Last time you traded well.')
  })
  it('returns null for nothing, so no continuity block is added', () => {
    for (const bad of [null, undefined, '', '   ', 123, {}, []]) {
      expect(continuityFrom(bad)).toBeNull()
    }
  })
  // A bound that exists only by convention is not a bound: the stored
  // narrative is normally model output, but nothing guarantees that.
  it('caps the length', () => {
    const huge = 'x'.repeat(MAX_CONTINUITY_CHARS * 3)
    expect(continuityFrom(huge).length).toBe(MAX_CONTINUITY_CHARS)
  })
})
