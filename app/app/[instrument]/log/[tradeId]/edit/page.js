'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../../../../lib/supabaseClient'
import { calcStopPrice, calcTargetPrice, calcRMultiple, calcRiskReward } from '../../../../../../lib/tradeMath'
import { isBlank, validateSetup, parseCurrency, formatCurrency } from '../../../../../../lib/tradeForm'

export default function EditTradePage({ params }) {
  const symbol = params.instrument
  const tradeId = params.tradeId
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [trade, setTrade] = useState(null)
  const [instrumentId, setInstrumentId] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [strategyId, setStrategyId] = useState('')
  const [addingStrategy, setAddingStrategy] = useState(false)
  const [newStrategyName, setNewStrategyName] = useState('')

  const [direction, setDirection] = useState('long')
  const [setup, setSetup] = useState({
    trade_date: '',
    trade_time: '',
    entry: '',
    target_distance: '',
    stop_distance: '',
  })
  const [errors, setErrors] = useState({})

  const [pnlInput, setPnlInput] = useState('')
  // Screenshots already saved on this trade, as plain URLs.
  const [existingScreenshots, setExistingScreenshots] = useState([])
  // Newly picked files not yet uploaded.
  const [screenshots, setScreenshots] = useState([])
  const [lightboxUrl, setLightboxUrl] = useState(null)

  const [saving, setSaving] = useState(false)

  const riskReward = calcRiskReward(parseFloat(setup.target_distance), parseFloat(setup.stop_distance))

  function updateSetup(field, value) {
    setSetup((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
  }

  useEffect(() => {
    loadAll()
  }, [tradeId])

  // Release object URLs for newly picked files on unmount. Tracked through a
  // ref because the cleanup runs once and would otherwise close over the
  // empty array this started with.
  const screenshotsRef = useRef(screenshots)
  screenshotsRef.current = screenshots
  useEffect(() => {
    return () => screenshotsRef.current.forEach((s) => URL.revokeObjectURL(s.previewUrl))
  }, [])

  async function loadAll() {
    setLoading(true)
    const { data: t } = await supabase.from('trades').select('*').eq('id', tradeId).single()
    if (!t) { setLoading(false); return }
    setTrade(t)
    setInstrumentId(t.instrument_id)
    setStrategyId(t.strategy_id || '')
    setDirection(t.direction)

    // Trades logged before distances existed only stored absolute prices,
    // so derive the distance from the price when the column is empty.
    setSetup({
      trade_date: t.trade_date || '',
      trade_time: t.trade_time || '',
      entry: t.entry ?? '',
      target_distance: t.target_distance ?? (t.target != null ? Math.abs(t.target - t.entry) : ''),
      stop_distance: t.stop_distance ?? (t.stop != null ? Math.abs(t.stop - t.entry) : ''),
    })
    setPnlInput(t.pnl === null || t.pnl === undefined ? '' : formatCurrency(t.pnl))
    setExistingScreenshots(t.screenshot_urls?.length ? t.screenshot_urls : (t.screenshot_url ? [t.screenshot_url] : []))

    const { data: stratData } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', t.instrument_id)
      .eq('archived', false)
      .order('created_at', { ascending: true })
    setStrategies(stratData || [])

    setLoading(false)
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
    if (error) {
      alert(error.message)
      return
    }
    setNewStrategyName('')
    setAddingStrategy(false)
    const { data: stratData } = await supabase
      .from('strategies')
      .select('*')
      .eq('instrument_id', instrumentId)
      .eq('archived', false)
      .order('created_at', { ascending: true })
    setStrategies(stratData || [])
    setStrategyId(data.id)
    setErrors((prev) => ({ ...prev, strategy: undefined }))
  }

  function handleScreenshotChange(e) {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setScreenshots((prev) => [
      ...prev,
      ...files.map((file) => ({ file, previewUrl: URL.createObjectURL(file) })),
    ])
    e.target.value = ''
  }

  function handleRemoveScreenshot(index) {
    setScreenshots((prev) => {
      const target = prev[index]
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

  function handleRemoveExistingScreenshot(index) {
    setExistingScreenshots((prev) => prev.filter((_, i) => i !== index))
  }

  function handlePnlFocus() {
    const parsed = parseCurrency(pnlInput)
    setPnlInput(parsed === null ? '' : String(parsed))
  }

  function handlePnlBlur() {
    const parsed = parseCurrency(pnlInput)
    setPnlInput(parsed === null ? '' : formatCurrency(parsed))
  }

  async function handleSubmit(e) {
    e.preventDefault()

    const foundErrors = validateSetup({ ...setup, direction, strategyId })
    if (Object.keys(foundErrors).length > 0) {
      setErrors(foundErrors)
      return
    }
    setErrors({})
    setSaving(true)

    const form = e.target

    const screenshot_urls = [...existingScreenshots]
    for (const shot of screenshots) {
      const fileExt = shot.file.name.split('.').pop()
      const filePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`
      const { error: uploadError } = await supabase.storage.from('screenshots').upload(filePath, shot.file)
      if (uploadError) {
        alert('Screenshot upload failed: ' + uploadError.message)
        setSaving(false)
        return
      }
      const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(filePath)
      screenshot_urls.push(urlData.publicUrl)
    }

    const entry = parseFloat(setup.entry)
    const stopDistance = parseFloat(setup.stop_distance)
    const targetDistance = parseFloat(setup.target_distance)
    const exitPrice = isBlank(form.exit_price.value) ? null : parseFloat(form.exit_price.value)

    const stopPrice = calcStopPrice(direction, entry, stopDistance)
    const targetPrice = calcTargetPrice(direction, entry, targetDistance)
    const rMultiple = calcRMultiple(direction, entry, stopPrice, exitPrice)

    const updatedTrade = {
      strategy_id: strategyId,
      trade_date: setup.trade_date,
      trade_time: setup.trade_time,
      direction,
      entry,
      stop: stopPrice,
      target: targetPrice,
      stop_distance: stopDistance,
      target_distance: targetDistance,
      exit_price: exitPrice,
      exit_time: form.exit_time.value || null,
      r_multiple: rMultiple,
      reasoning: form.reasoning.value.trim(),
      contracts: form.contracts.value ? parseInt(form.contracts.value) : null,
      pnl: parseCurrency(pnlInput),
      screenshot_urls,
      screenshot_url: screenshot_urls[0] || null,
    }

    const { error } = await supabase.from('trades').update(updatedTrade).eq('id', tradeId)

    if (error) {
      alert('Could not save trade: ' + error.message)
      setSaving(false)
      return
    }

    router.push(`/app/${symbol}/log`)
  }

  async function handleDelete() {
    if (!confirm('Delete this trade? This cannot be undone.')) return
    await supabase.from('trades').delete().eq('id', tradeId)
    router.push(`/app/${symbol}/log`)
  }

  if (loading) return <div className="page-loading">Loading…</div>
  if (!trade) return <div className="page-container"><div className="empty">Trade not found.</div></div>

  return (
    <div className="page-container">
      <a href={`/app/${symbol}/log`} className="back-link">← Back to log</a>
      <h1 className="page-title">{symbol} — Edit Trade</h1>

      <div className="panel">
        <form onSubmit={handleSubmit} noValidate>

          <div className="field full section-label">
            Trade Setup
            <span className="section-subtitle">
              These details define the setup and help EdgeLog identify it in market data.
            </span>
          </div>

          <div className="field half">
            <label>Strategy</label>
            <select value={strategyId} onChange={(e) => { setStrategyId(e.target.value); setErrors((prev) => ({ ...prev, strategy: undefined })) }}>
              {strategyId === '' && <option value="">Select a strategy…</option>}
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {errors.strategy && <span className="field-error">{errors.strategy}</span>}
            {addingStrategy ? (
              <div className="instrument-add-form" style={{ padding: '8px 0 0' }}>
                <input
                  type="text" placeholder="New strategy name" autoFocus
                  value={newStrategyName} onChange={(e) => setNewStrategyName(e.target.value)}
                />
                <button type="button" onClick={handleAddStrategy}>Add</button>
              </div>
            ) : (
              <span className="del" style={{ color: 'var(--accent)' }} onClick={() => setAddingStrategy(true)}>
                + Add new strategy
              </span>
            )}
          </div>
          <div className="field half">
            <label>Date</label>
            <input
              type="date" max={new Date().toISOString().split('T')[0]}
              value={setup.trade_date} onChange={(e) => updateSetup('trade_date', e.target.value)}
            />
            {errors.trade_date && <span className="field-error">{errors.trade_date}</span>}
          </div>

          <div className="field wide">
            <label>Entry time (to the second)</label>
            <input
              type="time" step="1"
              value={setup.trade_time} onChange={(e) => updateSetup('trade_time', e.target.value)}
            />
            {errors.trade_time && <span className="field-error">{errors.trade_time}</span>}
          </div>
          <div className="field wide">
            <label>Entry price</label>
            <input
              type="number" step="0.01"
              value={setup.entry} onChange={(e) => updateSetup('entry', e.target.value)}
            />
            {errors.entry && <span className="field-error">{errors.entry}</span>}
          </div>
          <div className="field wide">
            <label>Direction</label>
            <div className="dir-toggle">
              <div className={`dir-btn ${direction === 'long' ? 'active-long' : ''}`} onClick={() => setDirection('long')}>Long</div>
              <div className={`dir-btn ${direction === 'short' ? 'active-short' : ''}`} onClick={() => setDirection('short')}>Short</div>
            </div>
            {errors.direction && <span className="field-error">{errors.direction}</span>}
          </div>

          <div className="field wide">
            <label>Take Profit (in points)</label>
            <input
              type="number" step="0.01" min="0"
              value={setup.target_distance} onChange={(e) => updateSetup('target_distance', e.target.value)}
            />
            {errors.target_distance && <span className="field-error">{errors.target_distance}</span>}
          </div>
          <div className="field wide">
            <label>Stop Loss (in points)</label>
            <input
              type="number" step="0.01" min="0"
              value={setup.stop_distance} onChange={(e) => updateSetup('stop_distance', e.target.value)}
            />
            {errors.stop_distance && <span className="field-error">{errors.stop_distance}</span>}
          </div>
          <div className="field wide">
            <label>Risk-to-Reward ratio</label>
            <input type="text" readOnly tabIndex={-1} className="readonly-field" value={riskReward === null ? '—' : `1 : ${riskReward.toFixed(2)}`} />
          </div>

          <div className="field full section-label">
            Trade Execution
            <span className="section-subtitle">
              Record how the trade was executed, including contracts, exit details, and your final P&amp;L.
            </span>
          </div>

          <div className="field wide">
            <label>Contracts</label>
            <input name="contracts" type="number" step="1" defaultValue={trade.contracts ?? ''} />
          </div>
          <div className="field wide">
            <label>Actual exit time</label>
            <input name="exit_time" type="time" step="1" defaultValue={trade.exit_time ?? ''} />
          </div>
          <div className="field wide">
            <label>Actual exit price</label>
            <input name="exit_price" type="number" step="0.01" defaultValue={trade.exit_price ?? ''} />
          </div>
          <div className="field wide">
            <label>$ Profit or Loss</label>
            <div className="currency-field">
              <span className="currency-prefix">$</span>
              <input
                type="text" inputMode="decimal" placeholder="0.00"
                value={pnlInput}
                onChange={(e) => setPnlInput(e.target.value)}
                onFocus={handlePnlFocus}
                onBlur={handlePnlBlur}
              />
            </div>
          </div>
          <div className="field full">
            <label>Screenshot(s)</label>
            <input type="file" accept="image/*" multiple onChange={handleScreenshotChange} />
            {(existingScreenshots.length > 0 || screenshots.length > 0) && (
              <div className="screenshot-grid">
                {existingScreenshots.map((url, i) => (
                  <div key={url} className="screenshot-preview-wrap">
                    <img
                      src={url}
                      alt={`Screenshot ${i + 1}`}
                      className="screenshot-preview-thumb"
                      onClick={() => setLightboxUrl(url)}
                    />
                    <button
                      type="button"
                      className="screenshot-remove-btn"
                      onClick={() => handleRemoveExistingScreenshot(i)}
                      aria-label={`Remove screenshot ${i + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {screenshots.map((shot, i) => (
                  <div key={shot.previewUrl} className="screenshot-preview-wrap">
                    <img
                      src={shot.previewUrl}
                      alt={`New screenshot ${i + 1}`}
                      className="screenshot-preview-thumb"
                      onClick={() => setLightboxUrl(shot.previewUrl)}
                    />
                    <button
                      type="button"
                      className="screenshot-remove-btn"
                      onClick={() => handleRemoveScreenshot(i)}
                      aria-label={`Remove new screenshot ${i + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="field full section-label">
            Trade Review
            <span className="section-subtitle">
              Review your trade, record your observations, and identify areas for improvement.
            </span>
          </div>

          <div className="field full">
            <label>Why did you take it?</label>
            <textarea name="reasoning" defaultValue={trade.reasoning || ''} />
          </div>

          <div className="submit-row" style={{ justifyContent: 'space-between' }}>
            <span className="del" style={{ fontSize: '13px', alignSelf: 'center' }} onClick={handleDelete}>Delete this trade</span>
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        </form>
      </div>

      {lightboxUrl && (
        <div className="modal-overlay" onClick={() => setLightboxUrl(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-close" onClick={() => setLightboxUrl(null)}>✕</div>
            <img src={lightboxUrl} alt="Screenshot full view" />
          </div>
        </div>
      )}
    </div>
  )
}
