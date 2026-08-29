'use client'

import { useEffect, useState } from 'react'
import { getCachedInsight, regenerateInsight } from '@/lib/insightsClient'
import { parseNarrativeBlocks } from '@/lib/parseNarrative'

// Neutralizes the browser's default <button> chrome (border/background/
// padding/font) so it reads as the same plain text-link style
// .panel-link already gives an <a> elsewhere - a <button> is the more
// correct element here since it triggers an action rather than
// navigating anywhere.
const LINK_BUTTON_STYLE = { background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }

function fmtGeneratedAt(iso) {
  if (!iso) return ''
  return `As of ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

function NarrativeBlocks({ narrative }) {
  const blocks = parseNarrativeBlocks(narrative)
  return blocks.map((block, i) => block.type === 'table' ? (
    <div className="table-scroll" key={i}>
      <table className="session-breakdown-table">
        <thead>
          <tr>{block.headers.map((h, hi) => <th key={hi}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="brief-card-text" key={i}>{block.text}</p>
  ))
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
        <NarrativeBlocks narrative={state.narrative} />
      ) : (
        <p className="stat-placeholder">
          {state.error ? `Couldn't generate insights — ${state.error}` : 'No insight generated yet.'}
        </p>
      )}
      <div className="panel-link-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted-note">{fmtGeneratedAt(state.generatedAt)}</span>
        <button type="button" className="panel-link" style={LINK_BUTTON_STYLE} onClick={handleGenerate} disabled={regenerating}>
          {genLabel}
        </button>
      </div>
    </div>
  )
}
