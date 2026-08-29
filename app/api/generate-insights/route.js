import { createClient } from '@supabase/supabase-js'
import { overallInsightData, instrumentInsightData, strategyInsightData, totalTradeCount } from '@/lib/insightData'

const ANTHROPIC_MODEL = 'claude-sonnet-5'
const ANTHROPIC_MAX_TOKENS = 1536

// Deliberately explicit-but-not-prescriptive, per the trader's own
// instruction: state findings plainly enough that the implication is
// obvious, but never issue a directive - the trader decides what to do
// with a pattern, this doesn't decide for them. Every number handed to
// the model is raw and unsmoothed (lib/insightData.js) - the model itself
// is trusted to judge and state confidence given each finding's own
// sampleSize, rather than a Bayesian prior pre-deciding that.
//
// Output contract: whatever Markdown structure best conveys the findings
// - a table, a list, prose, or a mix - rendered as-is by
// components/EdgeInsightsPanel.js via react-markdown/remark-gfm. Earlier
// this forced a stricter paragraphs+GFM-tables-only shape (parsed by a
// small hand-rolled parser); removed by explicit trader request not to
// constrain the model's presentation.
const SYSTEM_PROMPT = `You are analyzing one trader's own historical trades for their personal trading journal. You will receive raw, unsmoothed statistics (win rate, average R, profit factor, dollar P&L) broken out by dimensions like session, day of week, discipline tags, strategy, and instrument - each with its own real sample size (labeled sampleSize). No number here has been smoothed or blended; every sampleSize is a real trade count. Any duration field (e.g. avgDrawdownDuration) is already formatted as text like "5m 31s" - use it exactly as given, never convert it back into a raw seconds count.

Open with a few sentences giving the overall picture. Beyond that, you decide the presentation - use whatever mix of plain prose, a Markdown table, or a short list best conveys each finding clearly. A table is one option among several, not a default: reach for one when there are genuinely several comparable rows worth seeing side by side (e.g. session or day-of-week performance, a mistake tag comparison), and skip it - just say it in a sentence - for a single-number finding or anything that doesn't naturally break into rows and columns.

Formatting rules:
- Standard Markdown is available: headers, bold/italics, bullet or numbered lists, and GitHub-flavored-markdown tables (header row, a "---" separator row, then pipe-separated data rows). Use whichever of these actually earns its place for a given finding - don't reach for structure the content doesn't need.
- Never write a sample size as mathematical notation like "n=5" or "(n=5)". Weave it naturally into the sentence instead - "based on 5 trades", "just 2 trades so far", "across 14 trades", "in all 3 instances".

Content rules:
- State findings explicitly and plainly - the trader should be able to see at a glance which specific session/day/tag/strategy combination is helping or hurting them, e.g. "Your Friday trades in the London session have lost money in 4 of 5 attempts, averaging -0.8R" rather than a vague summary.
- Always mention the sample size behind any specific claim, and say plainly when a pattern rests on too few trades to be confident yet (under 10 is thin, under 5 is very thin) - but still report what the data shows at that size, just be honest about how much weight it deserves.
- Do NOT tell the trader what to do. No "you should stop trading X", no concrete action recommendations, no prescriptions. State the pattern clearly enough that the implication is obvious, and let the trader draw their own conclusion.
- Beyond just restating each breakdown on its own, look for non-obvious connections across different parts of the data that the trader likely hasn't put together themselves - for example, a mistake tag clustering in one particular session or day, a session with a high win rate but a low average win size (or vice versa) suggesting something about position sizing or trade management there, an excursion pattern (MFE far exceeding MAE, or the reverse) that suggests the stop or target may be set inconsistently with how price actually moves, a day/session combination that looks fine on win rate but weak on expectancy, or a duration pattern (e.g. losses held much longer than wins, which can point to letting losers run) if the data given to you includes one. Trade duration (if present, under the "duration" field) is low-priority context, not a required talking point - it usually isn't a meaningful signal, so only mention it in the rare case where the actual numbers show something genuinely notable (e.g. a large, consistent gap between how long wins and losses are held); don't reach for a duration comment by default just because the field is there. State any such connection as a plain observation - still a description of what the data shows, not an instruction.
- Never invent a number that isn't in the data you were given, and never invent a connection the numbers don't actually support - only surface an inference that follows directly from the data you were given.
- If there truly isn't enough data yet to say anything meaningful, say that plainly rather than manufacturing a finding.
- Write in second person ("you"), plain conversational language.`

// Appended only when a previous write-up exists for this same scope, so a
// bare "no continuity yet" case doesn't carry instructions about a prior
// version that isn't there. Explicit trader request: regenerating
// shouldn't read as a blank rewrite each time - findings that still hold
// should carry over, and what's genuinely new/changed should be called
// out, rather than every version reading as unrelated to the last.
const CONTINUITY_INSTRUCTION = `

You previously wrote an analysis of this same trader's data, reproduced below. The data has since been refreshed (more trades, or the same trades with updated numbers) - write a new version informed by it rather than starting from a blank page: keep describing findings that still hold in the current data, update or drop any that no longer do, and note what's meaningfully new or changed since last time (e.g. a pattern that's strengthened, weakened, or newly appeared now that there's more data behind it). Don't just restate the previous text - the current data is the source of truth, the previous version is only there for continuity of framing.

Previous analysis:
"""
{previousNarrative}
"""`

async function callClaude(dataset, previousNarrative) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')

  const system = previousNarrative
    ? SYSTEM_PROMPT + CONTINUITY_INSTRUCTION.replace('{previousNarrative}', previousNarrative)
    : SYSTEM_PROMPT

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: JSON.stringify(dataset) }],
    }),
  })
  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${(await res.text()).slice(0, 500)}`)
  }
  const data = await res.json()
  const text = data.content?.[0]?.text
  if (!text) throw new Error('Anthropic API returned no text content')
  return text
}

// Reads are scoped to the CALLING user's own JWT (not
// SUPABASE_SERVICE_ROLE_KEY) - every query below goes through ordinary
// RLS as this specific user, so this route can only ever reach the data
// it's supposed to, the same as if the browser had queried directly. No
// admin/service-role access is needed here at all, unlike
// app/api/delete-account and app/api/record-login which genuinely need to
// act across RLS (deleting an auth user, reading another table's
// unrelated row) - this route only ever reads back the caller's own rows.
function scopedClient(token) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function buildDataset(supabase, scope) {
  if (scope === 'overall') {
    const { data: instruments } = await supabase.from('instruments').select('*').eq('archived', false)
    const ids = (instruments || []).map((i) => i.id)
    const { data: trades } = ids.length
      ? await supabase.from('trades').select('*').in('instrument_id', ids)
      : { data: [] }
    return { data: overallInsightData(trades || [], instruments || []), tradeCount: totalTradeCount(trades || []) }
  }

  if (scope.startsWith('instrument:')) {
    const instrumentId = scope.slice('instrument:'.length)
    const { data: instrument } = await supabase.from('instruments').select('*').eq('id', instrumentId).single()
    if (!instrument) return null
    const { data: strategies } = await supabase.from('strategies').select('*').eq('instrument_id', instrumentId).eq('archived', false)
    const { data: trades } = await supabase.from('trades').select('*').eq('instrument_id', instrumentId)
    return {
      data: instrumentInsightData(trades || [], strategies || [], instrument.symbol),
      tradeCount: totalTradeCount(trades || []),
    }
  }

  if (scope.startsWith('strategy:')) {
    const strategyId = scope.slice('strategy:'.length)
    const { data: strategy } = await supabase.from('strategies').select('*').eq('id', strategyId).single()
    if (!strategy) return null
    const { data: trades } = await supabase.from('trades').select('*').eq('strategy_id', strategyId)
    return {
      data: strategyInsightData(trades || [], strategy.name),
      tradeCount: totalTradeCount(trades || []),
    }
  }

  return null
}

// Mock-DB dev mode has no real Supabase session token to verify and no
// real ANTHROPIC_API_KEY to spend - short-circuits here with a canned
// narrative so the trigger/cache/display pipeline can still be verified
// end to end against the mock DB, the same reasoning as
// lib/screenshots.js's inline-SVG placeholder for a bucket that can't be
// mocked either. Includes a table so lib/parseNarrative.js's table-
// rendering path gets exercised too, not just the paragraph one.
const MOCK_NARRATIVE = `This is a placeholder insight shown in mock-DB dev mode — no real Claude API call is made here. Against production data, this panel holds Claude's actual written analysis of your trading history, structured the same way this placeholder is: a short summary, then a table where one's warranted.

| Session | Sample | Win rate |
| --- | --- | --- |
| London session | 5 trades | 40% |
| New York AM | 9 trades | 78% |`

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}))
    const { scope, tradeCount: clientTradeCount, previousNarrative } = body
    if (!scope) return new Response(JSON.stringify({ error: 'scope is required' }), { status: 400 })

    if (process.env.NEXT_PUBLIC_USE_MOCK_DB === 'true') {
      return new Response(
        JSON.stringify({ narrative: MOCK_NARRATIVE, generatedAt: new Date().toISOString(), tradeCount: clientTradeCount ?? 0 }),
        { status: 200 },
      )
    }

    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.replace('Bearer ', '').trim()
    if (!token) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })

    const supabase = scopedClient(token)
    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 })
    }

    const built = await buildDataset(supabase, scope)
    if (!built) return new Response(JSON.stringify({ error: 'Unknown or inaccessible scope' }), { status: 404 })

    const narrative = await callClaude(built.data, previousNarrative)
    const generatedAt = new Date().toISOString()

    return new Response(JSON.stringify({ narrative, generatedAt, tradeCount: built.tradeCount }), { status: 200 })
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Could not generate insights.' }), { status: 500 })
  }
}
