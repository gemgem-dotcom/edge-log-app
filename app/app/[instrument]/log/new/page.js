'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../../../lib/supabaseClient'
import { calcStopPrice, calcTargetPrice, calcRMultiple } from '../../../../../lib/tradeMath'

export default function NewTradePage({ params }) {
  const symbol = params.instrument
  const router = useRouter()

const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [strategyId, setStrategyId] = useState('')
  const [addingStrategy, setAddingStrategy] = useState(false)
  const [newStrategyName, setNewStrategyName] = useState('')

const [direction, setDirection] = useState('long')
  const [screenshotFile, setScreenshotFile] = useState(null)
  const [screenshotPreview, setScreenshotPreview] = useState(null)
  const [expandedPreview, setExpandedPreview] = useState(false)
  const [saving, setSaving] = useState(false)

const todayStr = new Date().toISOString().split('T')[0]

function handleScreenshotChange(e) {
  const file = e.target.files[0]
  if (!file) return
  setScreenshotFile(file)
  setScreenshotPreview(URL.createObjectURL(file))
}
  function handleRemoveScreenshot() {
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview)
    setScreenshotFile(null)
    setScreenshotPreview(null)
  }

useEffect(() => {
  loadStrategies()
}, [symbol])

async function loadStrategies() {
  const { data: { user } } = await supabase.auth.getUser()
  const { data: instrument } = await supabase
  .from('instruments')
  .select('*')
  .eq('user_id', user.id)
  .eq('symbol', symbol)
  .single()
  if (!instrument) return
  setInstrumentId(instrument.id)

  const { data } = await supabase
  .from('strategies')
  .select('*')
  .eq('instrument_id', instrument.id)
  .eq('archived', false)
  .order('created_at', { ascending: true })
  setStrategies(data || [])
  if (data && data.length > 0) setStrategyId(data[0].id)
}

async function handleAddStrategy(e) {
  e.preventDefault()
  if (!newStrategyName.trim()) return
  const { data: { user } } = await supabase.auth.getUser()
  const { data, error } = await supabase
  .from('strategies')
  .insert([{ user_id: user.id, instrument_id: instrumentId, name: newStrategyName.trim() }])
  .select()
  .single()
  if (!error) {
    setNewStrategyName('')
    setAddingStrategy(false)
    await loadStrategies()
    setStrategyId(data.id)
  } else {
    alert(error.message)
  }
}

async function handleSubmit(e) {
  e.preventDefault()
  if (!strategyId) {
    alert('Select or add a strategy first.')
    return
  }
  setSaving(true)
  const form = e.target
  const { data: { user } } = await supabase.auth.getUser()

  let screenshot_url = null
  if (screenshotFile) {
    const fileExt = screenshotFile.name.split('.').pop()
    const filePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`
    const { error: uploadError } = await supabase.storage.from('screenshots').upload(filePath, screenshotFile)
    if (uploadError) {
      const msg = uploadError.message?.includes('Bucket not found')
      ? 'Screenshot upload failed: the "screenshots" storage bucket doesn\'t exist yet in Supabase. Run the storage setup SQL (storage-setup.sql) or create it manually under Storage → New bucket → "screenshots" → Public.'
        : 'Screenshot upload failed: ' + uploadError.message
      alert(msg)
      setSaving(false)
      return
    }
    const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(filePath)
    screenshot_url = urlData.publicUrl
  }

  const entry = parseFloat(form.entry.value)
  const stopDistance = parseFloat(form.stop_distance.value)
  const targetDistance = form.target_distance.value ? parseFloat(form.target_distance.value) : null
  const distanceUnit = form.distance_unit.value
  const exitPrice = parseFloat(form.exit_price.value)

  const stopPrice = calcStopPrice(direction, entry, stopDistance)
  const targetPrice = calcTargetPrice(direction, entry, targetDistance)
  const rMultiple = calcRMultiple(direction, entry, stopPrice, exitPrice)

  if (rMultiple === null) {
    alert('Stop distance cannot be zero — R-multiple would be undefined.')
    setSaving(false)
    return
  }

  const newTrade = {
    user_id: user.id,
    instrument_id: instrumentId,
    strategy_id: strategyId,
    trade_date: form.trade_date.value,
    trade_time: form.trade_time.value,
    direction,
    entry,
    stop: stopPrice,
    target: targetPrice,
    stop_distance: stopDistance,
    target_distance: targetDistance,
    distance_unit: distanceUnit,
    exit_price: exitPrice,
    exit_time: form.exit_time.value || null,
    r_multiple: rMultiple,
    in_plan: form.in_plan.value === 'yes',
    reasoning: form.reasoning.value.trim(),
    contracts: form.contracts.value ? parseInt(form.contracts.value) : null,
    pnl: form.pnl.value ? parseFloat(form.pnl.value) : null,
    screenshot_url,
  }

  const { error } = await supabase.from('trades').insert([newTrade])

  if (error) {
    alert('Could not save trade: ' + error.message)
    setSaving(false)
    return
  }

  router.push(`/app/${symbol}/log`)
}

return (
  <div className="page-container">
  <h1 className="page-title">{symbol} — Log New Trade</h1>

<div className="panel">
  <form onSubmit={handleSubmit}>

  <div className="field full section-label">
  Technical — what the AI will use to find this setup in market data
  </div>
  <div className="field wide">
  <label>Date</label>
  <input name="trade_date" type="date" max={todayStr} required />
  </div>
  <div className="field wide">
  <label>Time (entry, to the second)</label>
  <input name="trade_time" type="time" step="1" required />
  </div>
  <div className="field wide">
  <label>Direction</label>
  <div className="dir-toggle">
  <div className={`dir-btn ${direction === 'long' ? 'active-long' : ''}`} onClick={() => setDirection('long')}>Long</div>
<div className={`dir-btn ${direction === 'short' ? 'active-short' : ''}`} onClick={() => setDirection('short')}>Short</div>
  </div>
  </div>

<div className="field wide">
  <label>Entry price</label>
<input name="entry" type="number" step="0.01" required />
  </div>
<div className="field wide">
  <label>Distance unit</label>
<select name="distance_unit" defaultValue="points">
  <option value="points">Points</option>
  <option value="ticks">Ticks</option>
</select>
  </div>
<div className="field wide">
  <label>Stop distance (from entry)</label>
<input name="stop_distance" type="number" step="0.01" min="0.01" required />
  </div>
<div className="field wide">
  <label>Target distance (from entry, optional)</label>
<input name="target_distance" type="number" step="0.01" min="0" />
  </div>

<div className="field wide">
  <label>Exit price</label>
<input name="exit_price" type="number" step="0.01" required />
  </div>
<div className="field wide">
  <label>Exit time</label>
<input name="exit_time" type="time" step="1" />
  </div>

<div className="field full section-label">
    Strategy — which model this trade belongs to
    </div>
<div className="field wide">
    <label>Strategy</label>
{strategies.length === 0 && !addingStrategy ? (
  <div className="empty" style={{ padding: '10px' }}>No strategies yet.</div>
) : (
  <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
{strategies.map((s) => (
  <option key={s.id} value={s.id}>{s.name}</option>
))}
  </select>
)}
</div>
<div className="field wide" style={{ justifyContent: 'flex-end' }}>
{addingStrategy ? (
  <div className="instrument-add-form" style={{ marginTop: '18px' }}>
<input
  type="text" placeholder="New strategy name" autoFocus
value={newStrategyName} onChange={(e) => setNewStrategyName(e.target.value)}
/>
  <button type="button" onClick={handleAddStrategy}>Add</button>
  </div>
) : (
  <span className="del" style={{ color: 'var(--accent)', marginTop: '18px' }} onClick={() => setAddingStrategy(true)}>
+ Add new strategy
  </span>
)}
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
  <label>Contracts traded (optional)</label>
<input name="contracts" type="number" step="1" />
  </div>
<div className="field wide">
  <label>$ Profit/Loss (optional)</label>
<input name="pnl" type="number" step="0.01" placeholder="e.g. 245.50 or -120" />
  </div>
<div className="field wide">
  <label>Screenshot (optional)</label>
{screenshotPreview ? (
  <div className="screenshot-preview-wrap">
  <img
  src={screenshotPreview}
 alt="Screenshot preview"
 className="screenshot-preview-thumb"
 onClick={() => setExpandedPreview(true)}
 />
   <button
 type="button"
 className="screenshot-remove-btn"
 onClick={handleRemoveScreenshot}
 aria-label="Remove screenshot"
 >
   ✕
   </button>
   </div>
 ) : (
   <input type="file" accept="image/*" onChange={handleScreenshotChange} />
   )}
   </div>
 <div className="field full">
   <label>Why did you take it?</label>
 <textarea name="reasoning" placeholder="One or two lines on the read at the time." />
   </div>

<div className="submit-row">
   <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Log trade'}</button>
  </div>
  </form>
</div>

{expandedPreview && screenshotPreview && (
  <div className="modal-overlay" onClick={() => setExpandedPreview(false)}>
<div className="modal-content" onClick={(e) => e.stopPropagation()}>
<div className="modal-close" onClick={() => setExpandedPreview(false)}>✕</div>
<img src={screenshotPreview} alt="Screenshot full view" />
  </div>
  </div>
)}
</div>
)
}
