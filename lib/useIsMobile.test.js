import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MOBILE_MAX_WIDTH, MOBILE_QUERY } from '@/lib/useIsMobile'

// The mobile breakpoint is stated twice - once in JS, which decides
// whether the mobile COMPONENTS mount, and once in globals.css, which
// decides whether the mobile RULES apply. Nothing in the language ties
// them together, so this does.
//
// A disagreement is not a cosmetic bug. In the band between two differing
// values you get one half of the design without the other: mobile markup
// under desktop styling, or desktop markup with the tab bar's body
// padding reserved under it. Both look like something is deeply broken,
// and neither would fail any other test in this suite.
//
// This is the same failure mode as the four calendar bugs documented in
// NOTES.md - a value the code assumed, agreeing with a fixture rather
// than with the thing it actually has to match - so it is checked against
// the real stylesheet rather than against a copy of the number.
const CSS = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

describe('the mobile breakpoint', () => {
  it('is the same number in the stylesheet as in the hook', () => {
    const banner = CSS.indexOf('/* ---------- Mobile app shell')
    expect(banner, 'the mobile CSS section should exist').toBeGreaterThan(-1)

    // Comments are stripped before the search. The section's own prose
    // discusses the older 640px rules by name, and matching that instead
    // of the real query is exactly the mistake this test caught the first
    // time it ran.
    const section = CSS.slice(banner).replace(/\/\*[\s\S]*?\*\//g, '')
    const query = /@media \(max-width:\s*(\d+)px\)/.exec(section)
    expect(query, 'the mobile section should open with a max-width query').not.toBeNull()
    expect(Number(query[1])).toBe(MOBILE_MAX_WIDTH)
  })

  it('builds a media query string matchMedia can actually use', () => {
    expect(MOBILE_QUERY).toBe(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
  })

  // The guarantee the whole design rests on: above the breakpoint, the
  // mobile rules must not merely lose a specificity contest - they must
  // not apply at all. That holds only while every rule after the banner
  // is inside the media query, so this checks the braces balance to zero
  // exactly once, at the end of the file.
  it('keeps every mobile rule inside the media query', () => {
    const section = CSS.slice(CSS.indexOf('/* ---------- Mobile app shell'))
    // Strip comments first - they contain braces in prose and would
    // otherwise be counted as code.
    const code = section.replace(/\/\*[\s\S]*?\*\//g, '')
    const open = code.indexOf('{')
    expect(open, 'the media query should open a block').toBeGreaterThan(-1)

    let depth = 0
    let closedAt = -1
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}') {
        depth--
        if (depth === 0) { closedAt = i; break }
      }
    }
    expect(closedAt, 'the media query should close').toBeGreaterThan(-1)
    // Nothing but whitespace may follow it, or that trailing rule would
    // apply at every width - including the desktop this must not touch.
    expect(code.slice(closedAt + 1).trim()).toBe('')
  })
})
