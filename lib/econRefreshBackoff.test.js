import { describe, it, expect } from 'vitest'
import {
  COOLDOWN_MS, MAX_BACKOFF_MS, ESCALATE_AT,
  backoffMs, notBeforeAfterFailure, shouldEscalate, isUpstreamFailure,
} from './econRefreshBackoff.mjs'

const MIN = 60_000

describe('backoffMs', () => {
  it('is the ordinary cooldown when nothing has failed', () => {
    expect(backoffMs(0)).toBe(COOLDOWN_MS)
  })

  // One refusal is the whole signal. There is no "probably a blip"
  // reading of a 403 that makes asking again in ten minutes polite.
  it('doubles from the very first refusal', () => {
    expect(backoffMs(1)).toBe(20 * MIN)
    expect(backoffMs(2)).toBe(40 * MIN)
    expect(backoffMs(3)).toBe(80 * MIN)
  })

  it('never waits longer than the cap', () => {
    expect(backoffMs(6)).toBe(MAX_BACKOFF_MS)
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS)
    // 2 ** 5000 is Infinity; the answer still has to be a wait.
    expect(backoffMs(5000)).toBe(MAX_BACKOFF_MS)
  })

  it('never waits less than the cooldown', () => {
    for (let n = 0; n < 30; n++) expect(backoffMs(n)).toBeGreaterThanOrEqual(COOLDOWN_MS)
  })

  // The count is read from a database row. Whatever comes back, the
  // answer is a finite wait - never NaN, which every comparison against
  // it would silently treat as "go ahead".
  it.each([[-1], [NaN], [undefined], [null], ['3'], [Infinity]])('treats %s as no failures', (bad) => {
    expect(backoffMs(bad)).toBe(COOLDOWN_MS)
  })
})

describe('notBeforeAfterFailure', () => {
  const NOW = Date.parse('2026-11-10T12:00:00.000Z')

  it('is now plus the backoff for the streak', () => {
    expect(notBeforeAfterFailure(NOW, 1)).toBe('2026-11-10T12:20:00.000Z')
    expect(notBeforeAfterFailure(NOW, 3)).toBe('2026-11-10T13:20:00.000Z')
  })

  it('is never more than the cap away', () => {
    expect(Date.parse(notBeforeAfterFailure(NOW, 99)) - NOW).toBe(MAX_BACKOFF_MS)
  })
})

describe('shouldEscalate', () => {
  // THE POINT OF THE WHOLE MODULE: one report per outage. 85 identical
  // events in a fortnight buried the three issues in the same list that
  // were real.
  it('fires exactly once on the way up', () => {
    const fired = []
    for (let n = 1; n <= 40; n++) if (shouldEscalate(n)) fired.push(n)
    expect(fired).toEqual([ESCALATE_AT])
  })

  it('does not fire on a healthy route', () => {
    expect(shouldEscalate(0)).toBe(false)
  })
})

describe('isUpstreamFailure', () => {
  it('counts an HTTP status from the source as theirs', () => {
    expect(isUpstreamFailure({ status: 403 })).toBe(true)
    expect(isUpstreamFailure({ status: 503 })).toBe(true)
  })

  it('counts a timeout or abort as theirs', () => {
    expect(isUpstreamFailure({ name: 'TimeoutError' })).toBe(true)
    expect(isUpstreamFailure({ name: 'AbortError' })).toBe(true)
    expect(isUpstreamFailure({ upstream: true })).toBe(true)
  })

  // A failed write, or anything thrown while handling a page that DID
  // arrive, is ours and must still reach Sentry. Getting this backwards
  // is how a real fault gets filed under "FF said no".
  it('does not excuse a fault of ours', () => {
    expect(isUpstreamFailure(new Error('duplicate key value violates unique constraint'))).toBe(false)
    expect(isUpstreamFailure(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false)
    expect(isUpstreamFailure(null)).toBe(false)
    expect(isUpstreamFailure(undefined)).toBe(false)
  })
})
