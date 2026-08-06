'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { calcStopPrice, calcTargetPrice, calcRMultiple, calcRiskReward, calcProfitLoss } from '../lib/tradeMath'
import { isBlank, validateSetup, validateExecution, parseCurrency, formatCurrency, todayDateString } from '../lib/tradeForm'
import { pointValueFor } from '../lib/instrumentCatalog'
import FieldTooltip from './FieldTooltip'

const DISTANCE_HINT = 'This is the figure shown on your position/long-short tool — the raw point distance from entry, not ticks or dollars.'

export const EMPTY_TRADE_FORM = {
  direction: 'long',
  strategyId: '',
  reasoning: '',
  setup: { trade_date: '', trade_time: '', entry: '', target_distance: '', stop_distance: '' },
  execution: { contracts: '', exit_time: '', exit_price: '' },
  pnl: null,
  existingScreenshots: [],
}

// The Trade Setup / Trade Execution / Trade Review form, shared by the new-
// and edit-trade pages. It owns every piece of form state, the validation and
// the derived figures, then hands the finished values to `onSubmit`.
//
// Persisting is deliberately left to the caller: the two pages insert vs
// update, and report screenshot upload failures differently.
//
// `initial` is read once on mount, so a caller with async data must not
// render this until that data has arrived.
export default function TradeForm({
  symbol,
  instrumentId,
  strategies = [],
  onStrategyAdded,
  initial = EMPTY_TRADE_FORM,
  autoSelectFirstStrategy = false,
  showEmptyStrategyMessage = false,
  submitLabel = 'Save',
  footerLeft = null,
  onSubmit,
}) {
  const [strategyId, setStrategyId] = useState(initial.strategyId)
  const [addingStrategy, setAddingStrategy] = useState(false)
  const [newStrategyName, setNewStrategyName] = useState('')

  // Trade setup — controlled so the R:R readout can update as you type and
  // so validation can inspect the values without touching the DOM.
  const [direction, setDirection] = useState(initial.direction)
  const [setup, setSetup] = useState(initial.setup)
  const [errors, setErrors] = useState({})

  // Trade execution — controlled so P&L can auto-fill from exit price and
  // contracts as they change.
  const [execution, setExecution] = useState(initial.execution)
  const [pnlInput, setPnlInput] = useState(initial.pnl == null ? '' : formatCurrency(initial.pnl))
  // Once the trader edits P&L by hand the auto-fill stops overwriting it,
  // until they clear the field again. A figure already stored on the trade
  // counts as manual, so reopening it never silently recalculates.
  const [pnlManual, setPnlManual] = useState(initial.pnl != null)

  const [existingScreenshots, setExistingScreenshots] = useState(initial.existingScreenshots)
  const [screenshots, setScreenshots] = useState([])
  const [lightboxUrl, setLightboxUrl] = useState(null)

  const [saving, setSaving] = useState(false)

  const todayStr = todayDateString()
  const riskReward = calcRiskReward(
    parseFloat(setup.target_distance),
    parseFloat(setup.stop_distance),
    direction,
    parseFloat(setup.entry),
  )

  // The new-trade page renders before its strategies have loaded, so the
  // first one is selected once they arrive. Never on the edit page, where an
  // empty selection means the trade is deliberately unclassified.
  useEffect(() => {
    if (!autoSelectFirstStrategy) return
    if (strategyId === '' && strategies.length > 0) setStrategyId(strategies[0].id)
  }, [autoSelectFirstStrategy, strategies, strategyId])

  // Auto-fill $ P&L once entry, exit price and contracts are all present.
  useEffect(() => {
    if (pnlManual) return
    const computed = calcProfitLoss(
      direction,
      parseFloat(setup.entry),
      parseFloat(execution.exit_price),
      parseFloat(execution.contracts),
      pointValueFor(symbol),
    )
    setPnlInput(computed === null ? '' : formatCurrency(computed))
  }, [pnlManual, direction, setup.entry, execution.exit_price, execution.contracts, symbol])

  // Object URLs are created per selected file, so release them on unmount.
  // Tracked through a ref because the cleanup runs once and would otherwise
  // close over the empty array this started with.
  const screenshotsRef = useRef(screenshots)
  screenshotsRef.current = screenshots
  useEffect(() => {
    return () => screenshotsRef.current.forEach((s) => URL.revokeObjectURL(s.previewUrl))
  }, [])

  function updateSetup(field, value) {
    setSetup((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
  }

  function updateExecution(field, value) {
    setExecution((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
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
    await onStrategyAdded?.()
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
    // Reset so picking the same file again still fires a change event.
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

  function handlePnlChange(value) {
    setPnlInput(value)
    // Clearing the field hands control back to the auto-calculation.
    setPnlManual(!isBlank(value))
  }

  function handlePnlBlur() {
    const parsed = parseCurrency(pnlInput)
    setPnlInput(parsed === null ? '' : formatCurrency(parsed))
  }

  async function handleSubmit(e) {
    e.preventDefault()

    const foundErrors = {
      ...validateSetup({ ...setup, direction, strategyId }),
      ...validateExecution(execution),
    }
    if (Object.keys(foundErrors).length > 0) {
      setErrors(foundErrors)
      return
    }
    setErrors({})
    setSaving(true)

    const form = e.target
    const entry = parseFloat(setup.entry)
    const stopDistance = parseFloat(setup.stop_distance)
    const targetDistance = parseFloat(setup.target_distance)
    const exitPrice = parseFloat(execution.exit_price)
    const stopPrice = calcStopPrice(direction, entry, stopDistance)
    const targetPrice = calcTargetPrice(direction, entry, targetDistance)

    const values = {
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
      exit_time: execution.exit_time || null,
      r_multiple: calcRMultiple(direction, entry, stopPrice, exitPrice),
      reasoning: form.reasoning.value.trim(),
      contracts: isBlank(execution.contracts) ? null : parseInt(execution.contracts),
      pnl: parseCurrency(pnlInput),
    }

    // The caller navigates away on success; returning false means it failed
    // and the form should become editable again.
    const result = await onSubmit({ values, screenshots, existingScreenshots })
    if (result === false) setSaving(false)
  }

  return (
    <>
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
            {showEmptyStrategyMessage && strategies.length === 0 && !addingStrategy ? (
              <div className="empty" style={{ padding: '10px' }}>No strategies yet.</div>
            ) : (
              <select value={strategyId} onChange={(e) => { setStrategyId(e.target.value); setErrors((prev) => ({ ...prev, strategy: undefined })) }}>
                {strategyId === '' && <option value="">Select a strategy…</option>}
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
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
              type="date" max={todayStr}
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
            <label>Take Profit (in points) <FieldTooltip text={DISTANCE_HINT} /></label>
            <input
              type="number" step="0.01" min="0"
              value={setup.target_distance} onChange={(e) => updateSetup('target_distance', e.target.value)}
            />
            {errors.target_distance && <span className="field-error">{errors.target_distance}</span>}
          </div>
          <div className="field wide">
            <label>Stop Loss (in points) <FieldTooltip text={DISTANCE_HINT} /></label>
            <input
              type="number" step="0.01" min="0"
              value={setup.stop_distance} onChange={(e) => updateSetup('stop_distance', e.target.value)}
            />
            {errors.stop_distance && <span className="field-error">{errors.stop_distance}</span>}
          </div>
          <div className="field wide">
            <label>Risk-to-Reward ratio</label>
            <input type="text" readOnly tabIndex={-1} className="readonly-field" value={riskReward === null ? '—' : riskReward.toFixed(2)} />
          </div>

          <div className="field full section-label">
            Trade Execution
            <span className="section-subtitle">
              Record how the trade was executed, including contracts, exit details, and your final P&amp;L.
            </span>
          </div>

          <div className="field wide">
            <label>Contracts</label>
            <input
              type="number" step="1"
              value={execution.contracts} onChange={(e) => updateExecution('contracts', e.target.value)}
            />
          </div>
          <div className="field wide">
            <label>Actual exit time (to the second)</label>
            <input
              type="time" step="1"
              value={execution.exit_time} onChange={(e) => updateExecution('exit_time', e.target.value)}
            />
          </div>
          <div className="field wide">
            <label>Actual exit price</label>
            <input
              type="number" step="0.01"
              value={execution.exit_price} onChange={(e) => updateExecution('exit_price', e.target.value)}
            />
            {errors.exit_price && <span className="field-error">{errors.exit_price}</span>}
          </div>
          <div className="field wide">
            <label>$ Profit or Loss</label>
            <div className="currency-field">
              <span className="currency-prefix">$</span>
              <input
                type="text" inputMode="decimal" placeholder="0.00"
                value={pnlInput}
                onChange={(e) => handlePnlChange(e.target.value)}
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
            <textarea name="reasoning" defaultValue={initial.reasoning} aria-label="Why did you take it?" />
          </div>

          <div className="submit-row" style={footerLeft ? { justifyContent: 'space-between' } : undefined}>
            {footerLeft}
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
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
    </>
  )
}
