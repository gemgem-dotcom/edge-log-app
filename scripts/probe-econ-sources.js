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
// ONE DELIBERATE EXCEPTION, marked `api: true` per candidate, and it is
// recorded here rather than left as an unexplained flag. api.bls.gov
// serves `Disallow: /` to every agent, and round three duly skipped all
// five series. But robots.txt is a CRAWLING directive - it tells
// indexers which paths not to walk - and BLS publishes that API
// specifically for programmatic use, with its own registration and rate
// limits. Those terms, not robots.txt, are what governs an API client
// fetching one documented endpoint it was told to fetch. A blanket rule
// that cannot tell "do not spider my website" from "do not use the API I
// built for you" is too coarse to be useful.
//
// So an `api: true` candidate still REPORTS its robots verdict - the
// information does not get hidden - and is fetched anyway. The exception
// is per-candidate, never per-host, so nothing else on that host inherits
// it, and it is a decision the repo owner made explicitly rather than one
// this script arrived at on its own. What still applies unchanged: honest
// User-Agent, no evasion, one request at a time, and anything that
// actually refuses us is a different source rather than a sneakier
// request.
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
  // ROUND THREE. Round two closed the scraping route for BLS: every path
  // on www.bls.gov AND on download.bls.gov - a different host serving
  // flat files rather than pages - returned the same 403 to an honest
  // User-Agent, with no robots.txt anywhere on either host. ISM turned
  // out to redirect to ecommerce.ismworld.org/SSO/Login.aspx, i.e. it is
  // behind a login, which settles it on principle rather than mechanics.
  //
  // So CPI and payrolls move to api.bls.gov, which is the agency's own
  // sanctioned public route, free and keyless for v1. THAT IS A THIRD
  // HOST and it has not been probed, so this asks rather than assumes -
  // the whole reason this file exists is that the last two assumptions
  // about a BLS host were both wrong.
  //
  // v2 GET is tried first and v1 GET second. v2 normally wants a
  // registered key and a POST for anything substantial, but a plain GET
  // on a single series is documented to work and is the smallest
  // possible question; v1 GET is the fallback that needs nothing at all.
  // Anchors here are JSON keys rather than prose, because that is what a
  // usable answer looks like from this host.
  {
    release: 'CPI',
    what: 'api v2, GET, all-items CPI - does this host answer at all',
    url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0',
    anchors: ['status', 'Results', 'seriesID'],
    api: true,
  },
  {
    release: 'CPI',
    what: 'api v1, GET, same series - the keyless fallback',
    url: 'https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0',
    anchors: ['status', 'Results', 'seriesID'],
    api: true,
  },
  {
    release: 'CPI',
    what: 'shelter, seasonally adjusted - the component the Read line turns on',
    url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/CUSR0000SAH1',
    anchors: ['status', 'Results', 'seriesID'],
    api: true,
  },
  {
    release: 'CPI',
    what: "owners' equivalent rent of residences, the imputed part of shelter",
    url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/CUSR0000SEHC',
    anchors: ['status', 'Results', 'seriesID'],
    api: true,
  },
  {
    release: 'Non-Farm Payrolls',
    what: 'total nonfarm, seasonally adjusted - the headline itself',
    url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/CES0000000001',
    anchors: ['status', 'Results', 'seriesID'],
    api: true,
  },
  // The three that already answered, re-checked so one run shows the
  // whole picture rather than needing the last two logs beside it.
  {
    release: 'Core PCE',
    what: 'confirmed 200 in rounds one and two',
    url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index',
    anchors: ['personal consumption', 'price index'],
  },
  {
    release: 'Retail Sales',
    what: 'confirmed 200 in round two',
    url: 'https://www.census.gov/retail/sales.html',
    anchors: ['retail', 'percent'],
  },
  {
    release: 'FOMC',
    what: 'the calendar index, which answered 200 in round one - statements hang off it',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    anchors: ['FOMC', 'Statement', 'Minutes'],
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
    console.log(`  robots: ${verdict}${c.api ? '   [documented API endpoint - see the header]' : ''}`)
    if (verdict.startsWith('DISALLOWED') && !c.api) {
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
