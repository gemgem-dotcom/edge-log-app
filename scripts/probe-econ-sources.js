#!/usr/bin/env node

// Read-only reconnaissance on the PRIMARY SOURCES behind the US releases
// the dashboard's brief already shows. Writes nothing, touches no
// database, follows no link it was not given. Run it from the "Run a
// diagnostic script" workflow (Actions -> Run workflow).
//
// WHY THIS EXISTS. The brief's "Read" line currently says the same thing
// about every release: a print above the forecast argues one way, below it
// the other. That is honest but it is also empty - it is true of every
// number ever published, and it is derived entirely from two figures the
// calendar already stores. What would make it worth reading is the part
// underneath the headline: that shelter is most of a CPI print and is an
// imputed rent nobody actually pays, that a payrolls number carries a
// model-estimated birth-death adjustment that is least reliable exactly
// at turning points, that ISM counts HOW MANY firms improved rather than
// by how much. Those are facts about the releases, they come from the
// agencies that publish them, and none of them is in Forex Factory's
// calendar.
//
// The dev sandbox cannot reach any of these hosts - the agent proxy
// answers 403 to CONNECT for every one, which is a policy denial rather
// than a network fault - so there is no way to learn what these pages
// actually look like from a terminal. Rather than write a parser against
// an imagined DOM and deploy it to find out, this asks every question at
// once and prints the answers.
//
// It answers, per candidate:
//   1. Does the host's robots.txt permit this path for a generic agent?
//   2. Does the URL resolve at all from a runner, and with what status,
//      content type and size?
//   3. Is what came back the real document, or a bot-check interstitial?
//   4. Does the document contain the specific anchors a parser would have
//      to find - the table captions and phrases that carry the numbers
//      worth quoting?
//
// ROBOTS IS CHECKED FIRST AND REPORTED PLAINLY, and a disallowed path is
// reported as disallowed rather than fetched anyway. These are public
// statistical agencies publishing public data and none of this is
// adversarial, but "it is public" is not the same as "they are happy to
// serve a robot", and the file is how they say so.
//
// ONE HONEST USER-AGENT, and no second attempt with a browser string.
// probe-forexfactory-sources.js tries both and explains why: knowing
// whether a site serves a plain truthful request is legitimate, and if it
// does there is no dilemma. The same reasoning applies here, but these
// hosts are government statistical agencies rather than a commercial site
// with a paid tier, so a plain request is the only one worth making. If a
// host refuses the honest identifier, the answer is a different source,
// not a sneakier request. Nothing here should ever grow TLS or
// fingerprint spoofing, challenge solving, or headless evasion.
//
// Usage: node scripts/probe-econ-sources.js

const UA = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const TIMEOUT_MS = 20000
// One at a time, with a gap. Nine requests spread over a few seconds is
// indistinguishable from a person reading, and these are small documents.
const GAP_MS = 1200

const CHALLENGE_MARKERS = [
  'just a moment', 'cf-browser-verification', '__cf_chl', 'attention required',
  'enable javascript and cookies', 'checking your browser', 'access denied',
  'request unsuccessful', 'incapsula', 'are you a robot',
]

// The candidates, and for each one the anchors a parser would need. The
// anchors are the point of the exercise: a 200 that does not contain them
// is a page that loaded and is still useless, and that is exactly the
// outcome worth knowing before writing a parser rather than after.
const CANDIDATES = [
  // ROUND TWO. The first run (Actions, 2026-10-28) answered four things:
  //   - bls.gov returns 403 to every path, honest UA, no robots.txt at
  //     all. CPI, CPI table 1, payrolls and the birth/death page alike,
  //     a 1323-byte refusal each. That is the host refusing a robot, and
  //     the file header says what happens next: a different source, not
  //     a browser User-Agent. These four are kept here, reported, and
  //     expected to keep failing - deleting them would lose the record
  //     of what was tried.
  //   - bea.gov and federalreserve.gov serve a plain request fine.
  //   - dol.gov serves the claims figures, as a 548KB PDF.
  //   - census.gov and ismworld.org both 404'd on URLs I had wrong, not
  //     on anything they did. Corrected below, with alternates.
  // New this round: download.bls.gov, which is a DIFFERENT HOST from the
  // one that refused us and publishes flat time-series files rather than
  // an API. If it serves them, CPI and payrolls detail is reachable
  // after all; if it 403s too, that detail is not available this way and
  // the Read line has to be built from what is.
  {
    release: 'CPI',
    what: 'flat time-series files - different host from the one that refused us',
    url: 'https://download.bls.gov/pub/time.series/cu/',
    anchors: ['cu.data', 'cu.series', 'Index of'],
  },
  {
    release: 'CPI',
    what: 'the current-month component file, if the directory above is served',
    url: 'https://download.bls.gov/pub/time.series/cu/cu.series',
    anchors: ['series_id', 'item_code'],
  },
  {
    release: 'Non-Farm Payrolls',
    what: 'CES flat files, including the birth/death adjustment series',
    url: 'https://download.bls.gov/pub/time.series/ce/',
    anchors: ['ce.data', 'ce.series', 'Index of'],
  },
  {
    release: 'CPI',
    what: 'the news release - expected 403, kept as the record of what was tried',
    url: 'https://www.bls.gov/news.release/cpi.nr0.htm',
    anchors: ['shelter', 'all items'],
  },
  {
    release: 'Non-Farm Payrolls',
    what: 'the news release - expected 403, same',
    url: 'https://www.bls.gov/news.release/empsit.nr0.htm',
    anchors: ['nonfarm payroll', 'revised'],
  },
  {
    release: 'Retail Sales',
    what: 'MARTS current release - corrected path',
    url: 'https://www.census.gov/retail/sales.html',
    anchors: ['retail', 'percent'],
  },
  {
    release: 'Retail Sales',
    what: 'the MARTS landing page, as an alternate',
    url: 'https://www.census.gov/retail/index.html',
    anchors: ['retail', 'advance'],
  },
  {
    release: 'ISM Manufacturing PMI',
    what: 'corrected path - the first URL redirected and then 404d',
    url: 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/',
    anchors: ['PMI', 'Report'],
  },
  {
    release: 'Core PCE',
    what: 'confirmed reachable in round one - re-checked for the table shape',
    url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index',
    anchors: ['personal consumption', 'price index', 'percent'],
  },
  {
    release: 'Core PCE',
    what: 'the actual release text, which is where the figures live',
    url: 'https://www.bea.gov/news/current-releases',
    anchors: ['personal income', 'release'],
  },
  {
    release: 'FOMC',
    what: 'confirmed reachable - a real statement, not the calendar index',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomcpresconf20260128.htm',
    anchors: ['FOMC', 'Committee'],
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, accept) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      // */* rather than a text/html list: several of these candidates are
      // flat data files and directory indexes, and a narrow Accept is an
      // easy way to manufacture a false negative on one.
      headers: { 'User-Agent': UA, Accept: accept || '*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    })
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, status: res.status, type: res.headers.get('content-type') || '', bytes: buf.length, body: buf, url: res.url }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message }
  } finally {
    clearTimeout(timer)
  }
}

// Deliberately simple: the generic-agent rules only, longest matching
// Disallow wins, and anything ambiguous is reported as ambiguous rather
// than resolved in our favour. This is a report, not an enforcement point.
function robotsVerdict(robotsText, path) {
  if (!robotsText) return 'no robots.txt'
  const lines = robotsText.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
  let inStar = false
  const rules = []
  for (const line of lines) {
    const m = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const [, field, value] = m
    if (/^user-agent$/i.test(field)) { inStar = value.trim() === '*'; continue }
    if (!inStar) continue
    if (!value) continue
    rules.push({ allow: /^allow$/i.test(field), path: value.trim() })
  }
  const matched = rules.filter((r) => path.startsWith(r.path))
  if (!matched.length) return 'allowed (no matching rule)'
  matched.sort((a, b) => b.path.length - a.path.length)
  const best = matched[0]
  const tie = matched.filter((r) => r.path.length === best.path.length)
  if (tie.length > 1 && new Set(tie.map((r) => r.allow)).size > 1) return `AMBIGUOUS (conflicting rules on "${best.path}")`
  return best.allow ? `allowed (Allow: ${best.path})` : `DISALLOWED (Disallow: ${best.path})`
}

async function main() {
  console.log('Probing primary sources for the brief\'s Read line')
  console.log(`User-Agent: ${UA}`)
  console.log('Read-only. No evasion. A disallowed path is reported, not fetched.\n')

  const robotsCache = new Map()
  let reachable = 0

  for (const c of CANDIDATES) {
    const u = new URL(c.url)
    console.log('='.repeat(72))
    console.log(`${c.release}  -  ${c.what}`)
    console.log(c.url)

    if (!robotsCache.has(u.origin)) {
      const r = await get(`${u.origin}/robots.txt`, 'text/plain')
      robotsCache.set(u.origin, r.ok && r.status === 200 ? r.body.toString('utf8') : null)
      await sleep(GAP_MS)
    }
    const verdict = robotsVerdict(robotsCache.get(u.origin), u.pathname)
    console.log(`  robots: ${verdict}`)
    if (verdict.startsWith('DISALLOWED')) {
      console.log('  SKIPPED - robots.txt disallows this path for a generic agent.\n')
      continue
    }

    const res = await get(c.url, c.url.endsWith('.pdf') ? 'application/pdf' : undefined)
    if (!res.ok) {
      console.log(`  FETCH FAILED: ${res.error}\n`)
      await sleep(GAP_MS)
      continue
    }
    console.log(`  status: ${res.status}   type: ${res.type.split(';')[0]}   bytes: ${res.bytes}`)
    if (res.url !== c.url) console.log(`  redirected to: ${res.url}`)

    if (res.status !== 200) {
      console.log('  -> not usable at this status\n')
      await sleep(GAP_MS)
      continue
    }

    const isPdf = res.type.includes('pdf') || res.body.slice(0, 4).toString() === '%PDF'
    if (isPdf) {
      console.log('  -> PDF, reachable. Not parsed here; note that a PDF parser is a')
      console.log('     dependency decision, not just a selector.')
      reachable += 1
      console.log()
      await sleep(GAP_MS)
      continue
    }

    const text = res.body.toString('utf8')
    const lower = text.toLowerCase()
    const challenge = CHALLENGE_MARKERS.filter((m) => lower.includes(m))
    if (challenge.length) {
      console.log(`  -> CHALLENGED (${challenge.join(', ')}). Use a different source, not a sneakier request.\n`)
      await sleep(GAP_MS)
      continue
    }

    const found = c.anchors.filter((a) => lower.includes(a.toLowerCase()))
    const missing = c.anchors.filter((a) => !lower.includes(a.toLowerCase()))
    console.log(`  anchors found  (${found.length}/${c.anchors.length}): ${found.join(' | ') || '(none)'}`)
    if (missing.length) console.log(`  anchors MISSING: ${missing.join(' | ')}`)
    console.log(`  tables: ${(text.match(/<table/gi) || []).length}   looks like a real document: ${text.length > 4000 ? 'yes' : 'SUSPICIOUSLY SMALL'}`)

    // A short window of real markup around the first anchor, so the next
    // step can be written against what is actually there rather than a
    // guess at it. Trimmed hard - this is a log, not a fixture dump.
    if (found.length) {
      const at = lower.indexOf(found[0].toLowerCase())
      const snippet = text.slice(Math.max(0, at - 240), at + 360).replace(/\s+/g, ' ')
      console.log(`  context: ...${snippet}...`)
    }
    if (found.length === c.anchors.length && c.anchors.length) reachable += 1
    console.log()
    await sleep(GAP_MS)
  }

  console.log('='.repeat(72))
  console.log(`${reachable} of ${CANDIDATES.length} candidates came back usable.`)
  console.log('Next step is a parser for whichever ones did - against captured markup,')
  console.log('not against this log.')
}

main().catch((err) => {
  console.error('Probe failed outright:', err)
  process.exit(1)
})
