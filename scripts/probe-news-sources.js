#!/usr/bin/env node

// Read-only reconnaissance on HEADLINE sources for the econ terminal.
// Writes nothing, touches no database, follows no link it was not given.
// Run it from the "Run a diagnostic script" workflow (Actions -> Run
// workflow).
//
// WHY THIS EXISTS. The terminal says what is SCHEDULED and, since the BLS
// work, what the scheduled number is made of. It cannot say what actually
// happened - a pipeline outage moving crude, a Fed speaker shifting the
// path between meetings, a payrolls print being revised in a press
// release rather than a series. Those arrive as headlines, and there is
// no headline anywhere in this app.
//
// THE PERMISSION QUESTION IS DIFFERENT HERE, AND IT IS THE WHOLE REASON
// THIS PROBE IS SEPARATE FROM probe-econ-sources.js. That one asked
// statistical agencies for public data they publish as a mandate. This
// one is asking, in part, commercial news organisations for editorial
// work they sell. Those are not the same request and should not be made
// with the same confidence.
//
// So the candidates are ordered by how clearly the publisher has said yes:
//
//   1. OFFICIAL FEEDS - a government body's own press-release RSS. The
//      body publishes it to be syndicated, the content is public record,
//      and it is first-party for exactly the events this app cares about.
//      This is where a headline feature should be built if it can be.
//   2. PUBLISHER RSS - a news organisation's own feed. An RSS feed is a
//      machine-readable document published FOR machines to read, which is
//      a materially stronger signal than "the page loaded". It is still
//      their content under their terms, and headline-plus-link-back is
//      the use those feeds exist for. Storing full article text is not,
//      and nothing built on this should.
//   3. ANYTHING ELSE - reported, not built on, without a decision from
//      the repo owner on the record, the way the api.bls.gov exception
//      was made and written down in the other probe's header.
//
// NO `api: true` EQUIVALENT HERE. In the other probe that flag marks one
// documented, agency-published API endpoint whose robots.txt is a
// crawling directive aimed at indexers. Nothing in this list has that
// character, so a DISALLOWED verdict is simply honoured. If a publisher's
// robots says no, the answer is a different source.
//
// ONE HONEST USER-AGENT, no second attempt with a browser string, no
// retry on a 403. A 403 to a truthful request is an answer.
//
// WHAT IT REPORTS, per candidate:
//   1. robots.txt verdict for the path, from the generic-agent rules.
//   2. Whether it resolves, with status, content type and size.
//   3. Whether what came back is a feed at all, and of what kind.
//   4. How many items, how fresh the newest one is, and whether items
//      carry the three fields a usable feed needs: title, link, date.
//   5. A few real headlines, so the NEXT decision - is this feed worth
//      reading for a futures journal, or is it celebrity stock tips - is
//      made on evidence rather than on the publisher's reputation.
//
// Point 5 is the one that actually decides this. Reachability is cheap;
// a feed that resolves perfectly and carries nothing a futures trader
// would act on is worse than no feed, because it looks like a feature.

const UA = 'EdgeLog/1.0 (trading journal; +https://github.com/gemgem-dotcom/edge-log-app)'
const TIMEOUT_MS = 20000
const GAP_MS = 1200

// Markers that say "this is a bot check, not the document".
const CHALLENGE_MARKERS = [
  'just a moment', 'cf-browser-verification', 'cf_chl', 'captcha',
  'enable javascript and cookies', 'access denied', 'request unsuccessful',
  'are you a robot', 'unusual traffic',
]

const CANDIDATES = [
  // ---- 1. Official feeds -------------------------------------------
  // The Fed publishes press releases as RSS and these ARE the events -
  // an FOMC statement is not reported news, it is the primary document.
  {
    tier: 'official',
    who: 'Federal Reserve - all press releases',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
  },
  {
    tier: 'official',
    who: 'Federal Reserve - monetary policy only (FOMC statements, minutes)',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
  },
  {
    tier: 'official',
    who: 'Federal Reserve - speeches, which move the path between meetings',
    url: 'https://www.federalreserve.gov/feeds/speeches.xml',
  },
  {
    tier: 'official',
    who: 'Treasury - press releases',
    url: 'https://home.treasury.gov/system/files/126/press_releases.xml',
  },
  {
    tier: 'official',
    who: 'BEA - news release feed (PCE, GDP)',
    url: 'https://apps.bea.gov/rss/rss.xml',
  },
  {
    tier: 'official',
    who: 'Census - economic indicator releases (retail sales, durables)',
    url: 'https://www.census.gov/economic-indicators/indicator.xml',
  },
  {
    tier: 'official',
    who: 'EIA - petroleum releases, the crude inventory print CL trades on',
    url: 'https://www.eia.gov/rss/todayinenergy.xml',
  },
  {
    tier: 'official',
    who: 'BLS - release feed, to see whether the feed host differs from the web host',
    url: 'https://www.bls.gov/feed/bls_latest.rss',
  },

  // ---- 2. Publisher RSS --------------------------------------------
  // Headline + link only if any of these is used. See the header.
  {
    tier: 'publisher',
    who: 'CNBC - markets',
    url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',
  },
  {
    tier: 'publisher',
    who: 'CNBC - economy',
    url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html?position=economy',
  },
  {
    tier: 'publisher',
    who: 'MarketWatch - top stories',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  },
  {
    tier: 'publisher',
    who: 'MarketWatch - market pulse',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
  },
  {
    tier: 'publisher',
    who: 'Yahoo Finance - headlines',
    url: 'https://finance.yahoo.com/news/rssindex',
  },
  {
    tier: 'publisher',
    who: 'Reuters - business, if the feed still exists',
    url: 'https://feeds.reuters.com/reuters/businessNews',
  },
  {
    tier: 'publisher',
    who: 'AP - business headlines',
    url: 'https://rsshub.app/apnews/topics/business',
  },
  {
    tier: 'publisher',
    who: 'Investing.com - economic news',
    url: 'https://www.investing.com/rss/news_14.rss',
  },
  {
    tier: 'publisher',
    who: 'Forex Factory - news, the host the calendar already reads',
    url: 'https://www.forexfactory.com/news',
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, accept) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
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

// Generic-agent rules only, longest matching Disallow wins, anything
// ambiguous reported as ambiguous rather than resolved in our favour.
// Same function as probe-econ-sources.js, duplicated rather than shared:
// these are throwaway diagnostics that should stay readable end to end on
// their own, and a shared helper would make one of them depend on the
// other's lifetime.
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

// Enough XML handling to describe a feed, and no more. This is a probe:
// it has to report what IS there, including shapes a real parser would
// reject, so it reads tags rather than validating a document.
function describeFeed(text) {
  const head = text.slice(0, 600).toLowerCase()
  let kind = null
  if (/<rss[\s>]/i.test(text)) kind = 'RSS'
  else if (/<feed[\s>][^>]*atom/i.test(text) || /xmlns="http:\/\/www\.w3\.org\/2005\/atom"/i.test(text)) kind = 'Atom'
  else if (head.trimStart().startsWith('{') || head.trimStart().startsWith('[')) kind = 'JSON'
  if (!kind) return null

  if (kind === 'JSON') {
    try {
      const j = JSON.parse(text)
      const items = Array.isArray(j) ? j : (j.items || j.articles || j.data || [])
      return { kind, count: Array.isArray(items) ? items.length : 0, items: [] }
    } catch { return { kind, count: 0, items: [] } }
  }

  const tag = kind === 'RSS' ? 'item' : 'entry'
  const blocks = text.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi')) || []
  const pick = (block, names) => {
    for (const n of names) {
      const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i').exec(block)
      if (m) return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      // Atom links carry the url in an attribute rather than as text.
      // Both quote styles: single quotes are valid XML, and a regex that
      // only accepts double ones reports "no link" for a perfectly good
      // feed. Caught locally against a hand-written Atom entry - the same
      // class of manufactured false negative the other probe's `Accept:
      // */*` note warns about.
      const a = new RegExp(`<${n}[^>]*href=("([^"]+)"|'([^']+)')`, 'i').exec(block)
      if (a) return a[2] || a[3]
    }
    return null
  }
  const items = blocks.map((b) => ({
    title: pick(b, ['title']),
    link: pick(b, ['link', 'guid', 'id']),
    date: pick(b, ['pubDate', 'published', 'updated', 'dc:date']),
  }))
  return { kind, count: blocks.length, items }
}

function ageOf(dateStr) {
  if (!dateStr) return null
  const t = Date.parse(dateStr)
  if (Number.isNaN(t)) return null
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 90) return `${mins} min old`
  const hrs = Math.round(mins / 60)
  return hrs < 72 ? `${hrs} h old` : `${Math.round(hrs / 24)} d old`
}

async function main() {
  console.log("Probing headline sources for the econ terminal")
  console.log(`User-Agent: ${UA}`)
  console.log('Read-only. No evasion. A disallowed path is reported, not fetched.')
  console.log('Official feeds first, publisher feeds second - see the header on why that order.\n')

  const robotsCache = new Map()
  const usable = []

  for (const c of CANDIDATES) {
    const u = new URL(c.url)
    console.log('='.repeat(72))
    console.log(`[${c.tier}] ${c.who}`)
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

    const res = await get(c.url, 'application/rss+xml, application/atom+xml, application/xml, */*')
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

    const text = res.body.toString('utf8')
    const challenge = CHALLENGE_MARKERS.filter((m) => text.toLowerCase().includes(m))
    if (challenge.length) {
      console.log(`  -> CHALLENGED (${challenge.join(', ')}). Different source, not a sneakier request.\n`)
      await sleep(GAP_MS)
      continue
    }

    const feed = describeFeed(text)
    if (!feed) {
      console.log('  -> not a feed. This is a page; parsing one is a different (and')
      console.log('     more fragile) decision than reading a feed the publisher offers.\n')
      await sleep(GAP_MS)
      continue
    }

    const withAll = feed.items.filter((i) => i.title && i.link && i.date).length
    const newest = feed.items.map((i) => i.date).find(Boolean)
    console.log(`  feed: ${feed.kind}   items: ${feed.count}   complete (title+link+date): ${withAll}/${feed.count}`)
    console.log(`  newest item: ${newest || '(no date field)'}${newest ? `   -> ${ageOf(newest) || 'unparseable date'}` : ''}`)

    // The part that actually decides it. Five real headlines say more
    // about whether this belongs in a futures journal than any amount of
    // status-code reporting.
    const sample = feed.items.filter((i) => i.title).slice(0, 5)
    if (sample.length) {
      console.log('  headlines:')
      for (const i of sample) console.log(`    - ${i.title.slice(0, 110)}`)
    } else {
      console.log('  headlines: NONE PARSED - the item shape is not what this probe assumed')
    }

    if (feed.count > 0 && withAll > 0) usable.push(`[${c.tier}] ${c.who}`)
    console.log()
    await sleep(GAP_MS)
  }

  console.log('='.repeat(72))
  console.log(`${usable.length} of ${CANDIDATES.length} candidates returned a usable feed:`)
  for (const u of usable) console.log(`  ${u}`)
  console.log('')
  console.log('Read the HEADLINES above, not just the counts. The question is not')
  console.log('whether a feed resolves - it is whether what it carries is worth')
  console.log('interrupting a trader for. A feed that resolves perfectly and carries')
  console.log('nothing actionable is worse than no feed, because it looks like a feature.')
}

main().catch((err) => {
  console.error('Probe failed outright:', err)
  process.exit(1)
})
