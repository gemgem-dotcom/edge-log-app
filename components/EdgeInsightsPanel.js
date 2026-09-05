'use client'

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getCachedInsight, regenerateInsight } from '@/lib/insightsClient'

function fmtGeneratedAt(iso) {
  if (!iso) return ''
  return `As of ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

// Claude's output isn't constrained to a paragraphs+tables contract
// anymore (explicit trader request: "it doesnt HAVE to use a table, it
// simply has to present its findings in a way thats most user friendly")
// - so this renders whatever Markdown it actually wrote, rather than
// parsing a narrow shape lib/parseNarrative.js used to enforce. Table
// markup is mapped onto the same look the app's other tables use.
function Narrative({ narrative }) {
  return (
    <div className="insight-narrative">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="table-scroll">
              <table className="session-breakdown-table">{children}</table>
            </div>
          ),
          p: ({ children }) => <p className="brief-card-text">{children}</p>,
        }}
      >
        {narrative}
      </ReactMarkdown>
    </div>
  )
}

// Shared by the All Instruments, per-instrument and per-strategy pages -
// each just passes its own scope string ('overall', 'instrument:<id>',
// 'strategy:<id>') and its own already-loaded trade count, so this is the
// one place that knows how to read/generate an insight and how to render
// its loading/empty/error states, rather than three copies of the same
// logic.
//
// Generation is manual-only (the Generate/Regenerate control) - no
// automatic Claude call ever fires on page load or on a trade-count
// threshold, since every call is real spend against the trader's own API
// billing.
export default function EdgeInsightsPanel({ scope, tradeCount }) {
  const [state, setState] = useState({ loading: true, narrative: null, generatedAt: null, error: null })
  const [regenerating, setRegenerating] = useState(false)

  useEffect(() => {
    if (tradeCount === 0) {
      setState({ loading: false, narrative: null, generatedAt: null, error: null })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    getCachedInsight(scope).then((result) => {
      if (!cancelled) setState({ loading: false, ...result })
    }).catch(() => {
      // Without this the panel sat on "Loading..." forever after any
      // network blip - the promise rejected with nothing attached to
      // handle it, so loading never cleared and there was nothing to retry.
      if (!cancelled) setState({ loading: false, narrative: null, generatedAt: null, error: "Couldn't load your insights. Please try again." })
    })
    return () => { cancelled = true }
  }, [scope, tradeCount])

  async function handleGenerate() {
    setRegenerating(true)
    const result = await regenerateInsight(scope, tradeCount)
    setState({ loading: false, ...result })
    setRegenerating(false)
  }

  if (tradeCount === 0) {
    return <p className="stat-placeholder">Log a few trades to see your first AI-generated insight here.</p>
  }
  if (state.loading) {
    return <p className="stat-placeholder">Loading…</p>
  }

  const genLabel = regenerating ? 'Generating…' : (state.narrative ? 'Regenerate' : 'Generate insight')

  return (
    <div>
      {state.narrative ? (
        <Narrative narrative={state.narrative} />
      ) : (
        <p className="stat-placeholder">
          {state.error || 'No insight generated yet.'}
        </p>
      )}
      <div className="panel-link-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="insight-narrative-generated-at">{fmtGeneratedAt(state.generatedAt)}</span>
        {/* A <span onClick>, not a <button> - matches how every other
            clickable-but-non-navigating action in this app is built
            (DatePicker.js's "Today", TradeLogTable.js's "Clear all") so it
            picks up .panel-link's hover underline cleanly instead of a
            <button>'s own default text-decoration rendering (confirmed
            live: a <button> here showed a doubled/thick underline on
            hover that this doesn't). */}
        <span
          className="panel-link"
          style={{ cursor: regenerating ? 'default' : 'pointer', opacity: regenerating ? 0.6 : 1 }}
          onClick={regenerating ? undefined : handleGenerate}
        >
          {genLabel}
        </span>
      </div>
    </div>
  )
}
