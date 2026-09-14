import { describe, it, expect } from 'vitest'
import { msUntilNextLocalMidnight } from './useCalendarNewsByDay'

// Only the timing arithmetic is covered here. The hook it drives needs a
// React renderer this repo deliberately doesn't carry (see CLAUDE.md:
// lib/*.test.js is pure-function coverage), and the interesting part - do
// we wake at the right moment - is pure.
//
// Dates are constructed with the local-time constructor rather than an ISO
// string on purpose: the function answers a question about the viewer's own
// midnight, so the test has to ask it in the same terms whatever timezone
// CI happens to run in.
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

describe('msUntilNextLocalMidnight', () => {
  it('counts to tonight\'s midnight, not 24 hours out', () => {
    // 11pm should wake in about an hour, which is the whole point: a
    // dashboard opened late must pick up tomorrow before tomorrow is over.
    const at11pm = new Date(2026, 8, 13, 23, 0, 0)
    expect(msUntilNextLocalMidnight(at11pm)).toBe(HOUR + SECOND)
  })

  it('waits nearly a full day when it is just past midnight', () => {
    const justAfterMidnight = new Date(2026, 8, 13, 0, 1, 0)
    expect(msUntilNextLocalMidnight(justAfterMidnight)).toBe(23 * HOUR + 59 * MINUTE + SECOND)
  })

  it('always lands after midnight, never a moment before it', () => {
    // A timer firing fractionally early would compute the day it had just
    // left, and the re-arm would be pointless. The slack makes that
    // impossible rather than unlikely.
    for (const hour of [0, 6, 12, 18, 23]) {
      const now = new Date(2026, 8, 13, hour, 59, 59, 999)
      const wakesAt = now.getTime() + msUntilNextLocalMidnight(now)
      const midnight = new Date(2026, 8, 13, 24, 0, 0, 0).getTime()
      expect(wakesAt).toBeGreaterThan(midnight - 1)
    }
  })

  it('is always positive and never more than a day and a second', () => {
    for (const hour of [0, 1, 7, 13, 19, 23]) {
      for (const minute of [0, 30, 59]) {
        const ms = msUntilNextLocalMidnight(new Date(2026, 8, 13, hour, minute, 0))
        expect(ms).toBeGreaterThan(0)
        expect(ms).toBeLessThanOrEqual(24 * HOUR + SECOND)
      }
    }
  })

  // Crossing into a new month or year must not produce a negative delay,
  // which would make setTimeout fire immediately and spin.
  it.each([
    ['end of a month', new Date(2026, 8, 30, 23, 30, 0)],
    ['end of a year', new Date(2026, 11, 31, 23, 30, 0)],
    ['a 31st', new Date(2026, 9, 31, 23, 30, 0)],
  ])('handles %s', (_label, now) => {
    expect(msUntilNextLocalMidnight(now)).toBe(30 * MINUTE + SECOND)
  })
})
