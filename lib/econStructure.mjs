// The structural caveat under a release: what the headline number is
// made of, and the specific reason it can mislead.
//
// WHY THIS IS CURATED AND NOT FETCHED, which is the honest distinction
// the whole module turns on. These are facts about METHODOLOGY, not about
// this month. Owners' equivalent rent is imputed whether or not anything
// was fetched this morning; the establishment survey's birth/death model
// was built the way it was built. They do not change release to release,
// so fetching them monthly would be theatre - and worse, it would imply
// the text is data when it is not.
//
// What IS fetched is the arithmetic that makes each one concrete: the
// actual month-on-month rates, from api.bls.gov, via
// scripts/fetch-econ-release-detail.js. The split is deliberate and the
// card shows it - a line built from a live figure reads differently from
// one that is standing methodology, and conflating them is how a page
// starts implying it knows more than it does.
//
// EVERY ENTRY STATES BOTH SIDES. Not "this number is wrong" - that is
// just the opposite bias wearing a lab coat - but the two readings a
// competent person could hold at once, with the structural fact that
// makes each of them defensible. If an entry only argues one way it is
// not finished.

// Titles that name a release of some OTHER economy. Everything in this
// module is a fact about a US statistical programme - BLS's shelter
// survey, the CES birth/death model - so attaching any of it to a German
// or Japanese CPI print would be straightforwardly false.
//
// This is defence in depth, not the primary filter: buildTodaysBrief
// already keeps USD rows only, and FF labels a German release EUR. But
// `\bcpi\b` matches "German Prelim CPI m/m" perfectly well, and the mock
// fixture - which deliberately mislabels that row USD to exercise an
// all-day shape - showed exactly what that costs: the card printed US
// owners' equivalent rent underneath a German print. One upstream filter
// between a regex and a false statement about another country's data is
// one too few.
const NOT_US = /\b(german|france|french|spanish|italian|euro|eurozone|ez|uk|british|japan|japanese|china|chinese|canada|canadian|australia|australian|new\s+zealand|swiss|switzerland|mexican|indian|korean|brazil)/i

export const STRUCTURE = [
  [/\bcore\s+cpi\b|\bcpi\b/i, {
    // Needs the two shelter series; renders a shorter form without them.
    needs: ['CUSR0000SAH1', 'CUSR0000SEHC'],
    build: ({ shelter, oer }) => {
      if (!shelter || !oer) {
        return 'Most of this index is services, and most of that is shelter - a '
          + 'component measured on a long survey cycle, so it reports rents agreed '
          + 'months ago rather than rents being agreed now. A print can be hot on '
          + 'last year’s leases while new ones are already cooling, and both of '
          + 'those are true at the same time.'
      }
      const gap = Math.round((shelter.percent - oer.percent) * 100) / 100
      const lede = `Shelter ran ${sign(shelter.percent)}% on the month and owners’ `
        + `equivalent rent ${sign(oer.percent)}%`
      const spread = gap === 0
        ? ', the two moving together'
        : `, a ${Math.abs(gap).toFixed(2)}pt spread`
      return `${lede}${spread}. OER is the larger of the two and it is IMPUTED - an `
        + 'estimate of what an owner would pay to rent their own home, which no '
        + 'household actually pays - and it is surveyed on a long cycle, so it '
        + 'reports leases signed months ago. '
        + (oer.percent > shelter.percent
          ? 'With OER running ahead of shelter overall, the index is being carried by the part of it nobody writes a cheque for: the case that this print overstates current inflation is a real one. '
          : 'With OER running behind shelter overall, the imputed part is damping the index rather than inflating it, which cuts the usual complaint the other way. ')
        + 'The case against: it is a quarter of what households spend and excluding '
        + 'it because it is awkward is not a method. Both readings survive the number.'
    },
  }],
  [/non-?farm|nfp|employment\s+change/i, {
    needs: ['CES0000000001'],
    // A revision is a live figure in its own right, and it arrives from a
    // different table than the detail row. Without this the card could
    // print "August was already revised down, 159,150 to 159,015" under a
    // label saying the line is not this month's data - which is a
    // contradiction the renderer cannot catch, because both halves look
    // fine on their own. Caught exactly that way: by rendering the card
    // with the detail table empty and reading what it said.
    live: (d) => Boolean(d.CES0000000001) || Boolean(d.revision),
    build: ({ payrolls, revision }) => {
      const parts = []
      if (payrolls?.preliminary) {
        parts.push('BLS still marks this print preliminary, so the figure being '
          + 'traded this morning is explicitly not the figure that will stand.')
      }
      if (revision) {
        const dir = revision.to > revision.from ? 'up' : 'down'
        parts.push(`${revision.periodName || revision.period} was already revised `
          + `${dir}, ${fmt(revision.from)} to ${fmt(revision.to)}, since this table `
          + 'last looked.')
      }
      parts.push('The establishment survey also carries a modelled birth/death '
        + 'adjustment for firms too new or too dead to answer, and that model is '
        + 'least reliable exactly at a turning point - it assumes the recent past '
        + 'continues, which is the assumption under question whenever the number '
        + 'matters most. The case the other way: it is the broadest, most timely '
        + 'labour read there is, and a model that is wrong at turns is still right '
        + 'most months. Both hold.')
      return parts.join(' ')
    },
  }],
]

function sign(n) {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

function fmt(n) {
  return Number(n).toLocaleString('en-US')
}

// The structural line for a release, or null when there is nothing
// specific to say about it. `detail` carries whatever the fetcher stored,
// keyed by series id; a missing series degrades the text rather than
// dropping it, because the methodology is true either way.
export function structureFor(title, detail = {}) {
  if (NOT_US.test(String(title || ''))) return null
  for (const [pattern, spec] of STRUCTURE) {
    if (!pattern.test(String(title || ''))) continue
    return spec.build({
      shelter: detail.CUSR0000SAH1 || null,
      oer: detail.CUSR0000SEHC || null,
      payrolls: detail.CES0000000001 || null,
      revision: detail.revision || null,
    })
  }
  return null
}

// Whether a given structural line was built with live figures or is
// standing methodology alone. The card labels the two differently, and
// this is the one function that decides which.
export function isLive(title, detail = {}) {
  if (NOT_US.test(String(title || ''))) return false
  for (const [pattern, spec] of STRUCTURE) {
    if (!pattern.test(String(title || ''))) continue
    // `needs` is the default test - every series the full text quotes.
    // An entry that can also be made live by something else says so with
    // its own `live`, which replaces that default rather than adding to
    // it. The question is always "did ANY figure in this sentence come
    // from a fetch", not "is the text complete".
    if (spec.live) return Boolean(spec.live(detail))
    return spec.needs.every((id) => Boolean(detail[id]))
  }
  return false
}
