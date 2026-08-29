'use client'

import { useEffect, useState } from 'react'
import { getInsight, regenerateInsight } from '@/lib/insightsClient'

// Neutralizes the browser's default <button> chrome (border/background/
// padding/font) so it reads as the same plain text-link style
// .panel-link already gives an <a> elsewhere - a <button> is the more
// correct element here since "Regenerate" triggers an action rather than
// navigating anywhere.
const LINK_BUTTON_STYLE = { background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }

function fmtGeneratedAt(iso) {
  if (!iso) return ''
  return `As of ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

// Shared by the All Instruments, per-instrument and per-strategy pages -
// each just passes its own scope string ('overall', 'instrument:<id>',
// 'strategy:<id>') and its own already-loaded trade count, so this is the
// one place that knows how to fetch-or-generate an insight and how to
// render its loading/empty/error states, rather than three copies of the
// same logic.
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
    getInsight(scope, tradeCount).then((result) => {
      if (!cancelled) setState({ loading: false, ...result })
    })
    return () => { cancelled = true }
  }, [scope, tradeCount])

  async function handleRegenerate() {
    setRegenerating(true)
    const result = await regenerateInsight(scope, tradeCount)
    setState({ loading: false, ...result })
    setRegenerating(false)
  }

  if (tradeCount === 0) {
    return <p className="stat-placeholder">Log a few trades to see your first AI-generated insight here.</p>
  }
  if (state.loading) {
    return <p className="stat-placeholder">Analyzing your trading history…</p>
  }
  if (state.error) {
    return <p className="stat-placeholder">Couldn&apos;t generate insights right now — {state.error}</p>
  }

  return (
    <div>
      <p className="brief-card-text" style={{ whiteSpace: 'pre-wrap' }}>{state.narrative}</p>
      <div className="panel-link-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted-note">{fmtGeneratedAt(state.generatedAt)}</span>
        <button type="button" className="panel-link" style={LINK_BUTTON_STYLE} onClick={handleRegenerate} disabled={regenerating}>
          {regenerating ? 'Regenerating…' : 'Regenerate'}
        </button>
      </div>
    </div>
  )
}
