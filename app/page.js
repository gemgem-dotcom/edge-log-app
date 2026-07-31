'use client'
// 'use client' tells Next.js: "this component runs in the browser,
// not on the server" — we need that because it uses useState, click
// handlers, and talks live to Supabase.

import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'

const THRESHOLD = 50

export default function Home() {
  // React "state" = data that, when it changes, makes the page
  // re-render automatically. `trades` holds every trade we've loaded
  // from the database. `loading` just controls a simple loading state.
  const [trades, setTrades] = useState([])
  const [loading, setLoading] = useState(true)
  const [direction, setDirection] = useState('long')
  const [saving, setSaving] = useState(false)
  const [screenshotFile, setScreenshotFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)

  // useEffect with an empty [] dependency array means:
  // "run this once, right when the page first loads."
  useEffect(() => {
    fetchTrades()
  }, [])

  async function fetchTrades() {
    setLoading(true)
    // .from('trades') = the table we made in Supabase.
    // .select('*') = get every column.
    // .order(...) = newest trades first.
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .order('trade_date', { ascending: false })
      .order('trade_time', { ascending: false })

    if (error) {
      console.error('Error fetching trades:', error)
    } else {
      setTrades(data)
    }
    setLoading(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)

    const form = e.target

    // If a screenshot was picked, upload it to the 'screenshots' storage
    // bucket first, and get back a public URL to save alongside the trade.
    let screenshot_url = null
    if (screenshotFile) {
      const fileExt = screenshotFile.name.split('.').pop()
      const filePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`
      const { error: uploadError } = await supabase.storage
        .from('screenshots')
        .upload(filePath, screenshotFile)

      if (uploadError) {
        alert('Screenshot upload failed: ' + uploadError.message)
        setSaving(false)
        return
      }
      const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(filePath)
      screenshot_url = urlData.publicUrl
    }

    const newTrade = {
      // --- technical: what the AI will use ---
      instrument: form.instrument.value.trim().toUpperCase(),
      trade_date: form.trade_date.value,
      trade_time: form.trade_time.value,
      direction,
      entry: parseFloat(form.entry.value),
      stop: parseFloat(form.stop.value),
      r_multiple: parseFloat(form.r_multiple.value),
      // --- behavioral: structured, drives your discipline stats ---
      in_plan: form.in_plan.value === 'yes',
      // --- context: for you only, the AI ignores these ---
      tag: form.tag.value.trim(),
      reasoning: form.reasoning.value.trim(),
      screenshot_url,
    }

    // .insert([...]) sends a new row to the trades table.
    const { error } = await supabase.from('trades').insert([newTrade])

    if (error) {
      alert('Could not save trade: ' + error.message)
    } else {
      form.reset()
      setDirection('long')
      setScreenshotFile(null)
      await fetchTrades() // reload the list so the new trade shows up
    }
    setSaving(false)
  }

  async function handleDelete(id) {
    const { error } = await supabase.from('trades').delete().eq('id', id)
    if (error) {
      alert('Could not delete: ' + error.message)
    } else {
      setTrades(trades.filter((t) => t.id !== id))
    }
  }

  // ---- Derived stats (tier 1 analysis) ----
  const n = trades.length
  const pct = Math.min(100, (n / THRESHOLD) * 100)
  let winRate = '—', avgR = null, expectancy = null

  if (n > 0) {
    const wins = trades.filter((t) => t.r_multiple > 0)
    const losses = trades.filter((t) => t.r_multiple < 0)
    winRate = ((wins.length / n) * 100).toFixed(1) + '%'
    avgR = trades.reduce((s, t) => s + t.r_multiple, 0) / n
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.r_multiple, 0) / wins.length : 0
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.r_multiple, 0) / losses.length : 0
    const wr = wins.length / n
    expectancy = wr * avgWin + (1 - wr) * avgLoss
  }

  return (
    <div className="wrap">
      <header>
        <div>
          <div className="title">Edge<span>Log</span> — Discretionary trade journal</div>
          <h1>NQ Journal</h1>
        </div>
        <div className="progress-card">
          <div className="progress-label">
            <span>Toward analysis threshold</span>
            <span className="progress-count">{n} / {THRESHOLD}</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: pct + '%' }} />
          </div>
          <div className="progress-note">
            {n >= THRESHOLD
              ? 'Threshold reached — enough data to begin pattern analysis.'
              : `${THRESHOLD - n} more trades until pattern analysis unlocks.`}
          </div>
        </div>
      </header>

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Trades logged</div>
          <div className="stat-value neu">{n}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value neu">{winRate}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg R</div>
          <div className={`stat-value ${avgR > 0 ? 'pos' : avgR < 0 ? 'neg' : 'neu'}`}>
            {avgR === null ? '—' : (avgR >= 0 ? '+' : '') + avgR.toFixed(2) + 'R'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Expectancy</div>
          <div className={`stat-value ${expectancy > 0 ? 'pos' : expectancy < 0 ? 'neg' : 'neu'}`}>
            {expectancy === null ? '—' : (expectancy >= 0 ? '+' : '') + expectancy.toFixed(2) + 'R'}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Log a trade</div>
        <form onSubmit={handleSubmit}>

          <div className="field full section-label">
            Technical — what the AI will use to find this setup in market data
          </div>
          <div className="field wide">
            <label>Instrument</label>
            <input name="instrument" type="text" defaultValue="NQ" required />
          </div>
          <div className="field wide">
            <label>Date</label>
            <input name="trade_date" type="date" required />
          </div>
          <div className="field wide">
            <label>Time (entry)</label>
            <input name="trade_time" type="time" step="60" required />
          </div>
          <div className="field wide">
            <label>Direction</label>
            <div className="dir-toggle">
              <div
                className={`dir-btn ${direction === 'long' ? 'active-long' : ''}`}
                onClick={() => setDirection('long')}
              >
                Long
              </div>
              <div
                className={`dir-btn ${direction === 'short' ? 'active-short' : ''}`}
                onClick={() => setDirection('short')}
              >
                Short
              </div>
            </div>
          </div>
          <div className="field wide">
            <label>Entry price</label>
            <input name="entry" type="number" step="0.01" placeholder="20145.25" required />
          </div>
          <div className="field wide">
            <label>Stop price</label>
            <input name="stop" type="number" step="0.01" placeholder="20138.00" required />
          </div>
          <div className="field wide">
            <label>R multiple result</label>
            <input name="r_multiple" type="number" step="0.01" placeholder="2.4 or -1" required />
          </div>

          <div className="field full section-label">
            Behavioral — drives your discipline stats, not used to locate the setup
          </div>
          <div className="field wide">
            <label>In-plan?</label>
            <select name="in_plan" defaultValue="yes">
              <option value="yes">Yes — followed my strategy</option>
              <option value="no">No — off-plan / impulse</option>
            </select>
          </div>

          <div className="field full section-label">
            Context — for you only, the AI ignores this
          </div>
          <div className="field wide">
            <label>Setup tag (optional)</label>
            <input name="tag" type="text" placeholder="e.g. London sweep reversal" />
          </div>
          <div className="field wide">
            <label>Screenshot (optional)</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setScreenshotFile(e.target.files[0] || null)}
            />
          </div>
          <div className="field full">
            <label>Why did you take it?</label>
            <textarea name="reasoning" placeholder="One or two lines on the read at the time." />
          </div>

          <div className="submit-row">
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Log trade'}
            </button>
          </div>
        </form>
      </div>

      <div className="panel">
        <div className="panel-title">Log</div>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : n === 0 ? (
          <div className="empty">No trades logged yet. Log your first trade above.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date / Time</th><th>Instr</th><th>Dir</th><th>Entry</th>
                <th>Stop</th><th>Result</th><th>Plan</th><th>Tag</th><th>Shot</th><th></th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const rClass = t.r_multiple > 0 ? 'r-pos' : t.r_multiple < 0 ? 'r-neg' : 'r-zero'
                return (
                  <tr key={t.id}>
                    <td>{t.trade_date}<br /><span style={{ color: 'var(--muted)' }}>{t.trade_time}</span></td>
                    <td>{t.instrument}</td>
                    <td style={{ color: t.direction === 'long' ? 'var(--win)' : 'var(--loss)' }}>
                      {t.direction.toUpperCase()}
                    </td>
                    <td>{t.entry}</td>
                    <td>{t.stop}</td>
                    <td><span className={`r-pill ${rClass}`}>{(t.r_multiple >= 0 ? '+' : '') + t.r_multiple}R</span></td>
                    <td>{t.in_plan ? '✓' : <span style={{ color: 'var(--loss)' }}>✕</span>}</td>
                    <td className="tag-cell">{t.tag || '—'}</td>
                    <td>
                      {t.screenshot_url ? (
                        <img
                          src={t.screenshot_url}
                          alt="Trade screenshot"
                          className="thumb"
                          onClick={() => setPreviewUrl(t.screenshot_url)}
                        />
                      ) : '—'}
                    </td>
                    <td><span className="del" onClick={() => handleDelete(t.id)}>remove</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="footnote">Your trades, stored in your own database.</div>

      {previewUrl && (
        <div className="modal-overlay" onClick={() => setPreviewUrl(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-close" onClick={() => setPreviewUrl(null)}>✕</div>
            <img src={previewUrl} alt="Trade screenshot full view" />
          </div>
        </div>
      )}
    </div>
  )
}
