import { describe, it, expect } from 'vitest'
import { structureFor, isLive, STRUCTURE } from './econStructure.mjs'

// The live September 2026 rates, computed by lib/econSeries.mjs from what
// api.bls.gov actually returned.
// NOTE the direction, which is easy to get backwards and was: OER's
// INDEX LEVEL (445.265) is higher than shelter's (431.908), but those are
// differently-based series and comparing their levels says nothing. On
// the rates that matter, shelter ran +0.39% and OER +0.35% - OER is
// running COOLER, which flips which argument the line makes.
const SHELTER = { percent: 0.39, period: 'M09', preliminary: false }
const OER_LIVE = { percent: 0.35, period: 'M09', preliminary: false }
const OER_ABOVE = { percent: 0.48, period: 'M09', preliminary: false }
const NFP = { percent: 0.02, period: 'M09', preliminary: true }

describe('structureFor - CPI', () => {
  const line = structureFor('CPI m/m', { CUSR0000SAH1: SHELTER, CUSR0000SEHC: OER_LIVE })

  it('quotes both live rates', () => {
    expect(line).toContain('+0.39%')
    expect(line).toContain('+0.35%')
  })
  it('names the spread between them', () => {
    expect(line).toContain('0.04pt')
  })
  it('says plainly that OER is imputed and unpaid', () => {
    expect(line).toMatch(/imputed/i)
    expect(line).toMatch(/no household actually pays/i)
  })
  it('states the lag that makes a hot print ambiguous', () => {
    expect(line).toMatch(/months ago/i)
  })

  // The whole commission: give all sides equally. A line that only
  // argues one way has failed even if every word in it is true.
  it('argues BOTH directions, not just the sceptical one', () => {
    // On the live month OER is the COOLER of the two, so the line takes
    // the damping branch - and still has to carry the counter-argument.
    expect(line).toMatch(/damping the index rather than inflating it/i)
    expect(line).toMatch(/excluding it because it is awkward is not a method/i)
  })
  it('flips the argument when OER runs HOTTER than shelter', () => {
    const hot = structureFor('CPI m/m', { CUSR0000SAH1: SHELTER, CUSR0000SEHC: OER_ABOVE })
    expect(hot).toMatch(/overstates current inflation/i)
    expect(hot).not.toMatch(/damping the index/i)
  })
  it('still says something true with no series at all', () => {
    const bare = structureFor('CPI m/m', {})
    expect(bare).toMatch(/shelter/i)
    expect(bare).not.toContain('%')
  })
  it('matches core CPI as well as headline', () => {
    expect(structureFor('Core CPI m/m', {})).toBeTruthy()
  })
})

describe('structureFor - payrolls', () => {
  it('leads on the preliminary flag when BLS sets it', () => {
    const line = structureFor('Non-Farm Employment Change', { CES0000000001: NFP })
    expect(line).toMatch(/explicitly not the figure that will stand/i)
  })
  it('omits the preliminary clause when the print is final', () => {
    const final = structureFor('Non-Farm Employment Change', { CES0000000001: { ...NFP, preliminary: false } })
    expect(final).not.toMatch(/preliminary/i)
  })
  it('reports a real revision with both numbers and a direction', () => {
    const line = structureFor('Non-Farm Employment Change', {
      CES0000000001: NFP,
      revision: { periodName: 'August', from: 159015, to: 158880 },
    })
    expect(line).toContain('159,015')
    expect(line).toContain('158,880')
    expect(line).toMatch(/revised down/i)
  })
  it('calls an upward revision up', () => {
    const line = structureFor('Non-Farm Employment Change', {
      CES0000000001: NFP,
      revision: { periodName: 'August', from: 158880, to: 159015 },
    })
    expect(line).toMatch(/revised up/i)
  })
  it('explains birth/death and then argues against itself', () => {
    const line = structureFor('NFP', {})
    expect(line).toMatch(/birth\/death/i)
    expect(line).toMatch(/least reliable exactly at a turning point/i)
    expect(line).toMatch(/still right\s+most months/i)
  })
})

describe('structureFor - scope', () => {
  it('returns null for a release with nothing specific to say', () => {
    expect(structureFor('Unemployment Claims', {})).toBeNull()
    expect(structureFor('', {})).toBeNull()
    expect(structureFor(null, {})).toBeNull()
  })
})

describe('isLive', () => {
  it('is true only when every series the line needs is present', () => {
    expect(isLive('CPI m/m', { CUSR0000SAH1: SHELTER, CUSR0000SEHC: OER_LIVE })).toBe(true)
    expect(isLive('CPI m/m', { CUSR0000SAH1: SHELTER })).toBe(false)
    expect(isLive('CPI m/m', {})).toBe(false)
  })
  it('is false for a release with no structural entry', () => {
    expect(isLive('Unemployment Claims', {})).toBe(false)
  })
})

// A guard on the commission rather than on any one string: if an entry
// is ever rewritten to argue a single direction, this fails.
describe('every structural entry states both sides', () => {
  // Every branch of every entry has to end on an explicit both-sides
  // sentence. A loose regex over whatever wording happened to be used
  // lets a rewrite quietly drop the counter-argument, which is the one
  // thing this guard exists to stop - so the commitment is a fixed
  // phrase, and the texts are written to carry it.
  const BOTH = [/\bboth\b[^.]*\.(?:\s|$)/i]
  for (const [pattern] of STRUCTURE) {
    it(`${pattern} carries a counter-argument`, () => {
      const title = pattern.source.includes('cpi') ? 'CPI m/m' : 'Non-Farm Employment Change'
      const line = structureFor(title, {})
      expect(line).toBeTruthy()
      expect(BOTH.some((re) => re.test(line))).toBe(true)
    })
  }
})

// A US statistical caveat under a foreign release is not a nuance, it is
// a false statement. `\bcpi\b` matches "German Prelim CPI m/m", and the
// mock fixture caught this live: the card rendered BLS owners' equivalent
// rent underneath a German print.
describe('non-US releases get no US structural line', () => {
  for (const title of [
    'German Prelim CPI m/m',
    'French Final CPI y/y',
    'Spanish Flash CPI y/y',
    'UK CPI y/y',
    'Japan Core CPI y/y',
    'Canadian Employment Change',
    'Australian Employment Change',
  ]) {
    it(`says nothing about ${title}`, () => {
      expect(structureFor(title, {
        CUSR0000SAH1: SHELTER, CUSR0000SEHC: OER_LIVE, CES0000000001: NFP,
      })).toBeNull()
      expect(isLive(title, { CUSR0000SAH1: SHELTER, CUSR0000SEHC: OER_LIVE })).toBe(false)
    })
  }
  it('still answers for the US releases themselves', () => {
    expect(structureFor('CPI m/m', {})).toBeTruthy()
    expect(structureFor('Non-Farm Employment Change', {})).toBeTruthy()
  })
})

// The label has to follow the SENTENCE, not the series list. A revision
// comes from its own table, so a payrolls line can quote a live figure
// with no detail row in hand - and labelling that "how it is built, not
// this month's data" would be plainly false.
describe('isLive follows what the text actually quotes', () => {
  const title = 'Non-Farm Employment Change'
  const revision = { periodName: 'August', from: 159150, to: 159015 }

  it('is live on a revision alone', () => {
    expect(isLive(title, { revision })).toBe(true)
    expect(structureFor(title, { revision })).toContain('159,150')
  })
  it('is live on the detail row alone', () => {
    expect(isLive(title, { CES0000000001: NFP })).toBe(true)
  })
  it('is not live with neither', () => {
    expect(isLive(title, {})).toBe(false)
  })
})
