'use client'

import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { calcStopPrice, calcTargetPrice, calcRMultiple, calcRiskReward, calcProfitLoss } from '../lib/tradeMath'
import { isBlank, validateSetup, validateExecution, parseCurrency, formatCurrency, toDecimalString, todayDateString, MIN_TRADE_DATE } from '../lib/tradeForm'
import { pointValueFor } from '../lib/instrumentCatalog'
import { useClickOutside } from '../lib/useClickOutside'
import FieldTooltip from './FieldTooltip'
import ErrorBanner from './ErrorBanner'
import DatePicker from './DatePicker'
import TimePicker from './TimePicker'

const DISTANCE_HINT = 'This is the figure shown on your position/long-short tool — the raw point distance from entry, not ticks or dollars.'
const SCREENSHOT_PASTE_HINT = 'You can also paste a screenshot directly from your clipboard (Ctrl+V / Cmd+V) instead of choosing a file.'

export const EMPTY_TRADE_FORM = {
  direction: 'long',
  strategyId: '',
  reasoning: '',
  setup: { trade_date: '', trade_time: '', entry: '', target_distance: '', stop_distance: '' },
  execution: { contracts: '', exit_time: '', exit_price: '' },
  pnl: null,
  tags: [],
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
  allowDiscard = false,
  onSubmit,
}) {
  // Only the edit-trade page passes allowDiscard - tracking every field
  // that could make the form "dirty" is only worth doing where there's a
  // saved trade underneath to discard back to.
  const [dirty, setDirty] = useState(false)
  const reasoningRef = useRef(null)

  const [strategyId, setStrategyId] = useState(initial.strategyId)
  const [addingStrategy, setAddingStrategy] = useState(false)
  const [newStrategyName, setNewStrategyName] = useState('')

  // Trade setup — controlled so the R:R readout can update as you type and
  // so validation can inspect the values without touching the DOM.
  const [direction, setDirection] = useState(initial.direction)
  const [setup, setSetup] = useState(initial.setup)
  const [errors, setErrors] = useState({})
  // Whole-form failure (save/upload) - distinct from the per-field errors
  // above, which validation sets. Cleared at the start of every submit
  // attempt so a stale banner never survives a retry.
  const [formError, setFormError] = useState(null)

  // Trade execution — controlled so P&L can auto-fill from exit price and
  // contracts as they change.
  const [execution, setExecution] = useState(initial.execution)
  const [pnlInput, setPnlInput] = useState(initial.pnl == null ? '' : formatCurrency(initial.pnl))
  // Once the trader edits P&L by hand the auto-fill stops overwriting it,
  // until they clear the field again. A trade's stored P&L can't be told
  // apart from a manual one just by being present - it's almost always
  // there, whether it was auto-calculated or typed - so this instead
  // recomputes what auto-fill would have produced from the trade's own
  // stored inputs and only treats it as manual if that figure doesn't
  // match. Otherwise editing Contracts/entry/exit on the edit page could
  // never auto-update the way it does on the new-trade page.
  const initialComputed = calcProfitLoss(
    initial.direction,
    parseFloat(initial.setup.entry),
    parseFloat(initial.execution.exit_price),
    parseFloat(initial.execution.contracts),
    pointValueFor(symbol),
  )
  const [pnlManual, setPnlManual] = useState(
    initial.pnl != null && (initialComputed === null || Math.abs(initialComputed - initial.pnl) > 0.005)
  )

  const [existingScreenshots, setExistingScreenshots] = useState(initial.existingScreenshots)
  const [screenshots, setScreenshots] = useState([])
  const [lightboxUrl, setLightboxUrl] = useState(null)

  const [tags, setTags] = useState(initial.tags || [])
  const [addingTag, setAddingTag] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [existingTags, setExistingTags] = useState([])
  // Separate from addingTag, which keeps the tag input itself open - this
  // only governs the suggestions dropdown, so scrolling or clicking away
  // closes the dropdown without losing whatever's mid-typed in the input.
  const [showSuggestions, setShowSuggestions] = useState(false)

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

  // Tag suggestions for the dropdown below - every tag currently in use on
  // any of the trader's trades, across every instrument (tags like "FOMC"
  // aren't instrument-specific). There's still no separate tags table (see
  // schema.sql): this list is derived fresh from trades.tags each time the
  // form mounts, so a tag that's no longer on any trade just stops
  // appearing here on its own, with nothing to clean up.
  useEffect(() => {
    let cancelled = false
    async function loadTagSuggestions() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('trades').select('tags').eq('user_id', user.id)
      if (cancelled) return
      const seen = new Map()
      for (const row of data || []) {
        for (const tag of row.tags || []) {
          const key = tag.toLowerCase()
          if (!seen.has(key)) seen.set(key, tag)
        }
      }
      setExistingTags([...seen.values()].sort((a, b) => a.localeCompare(b)))
    }
    loadTagSuggestions()
    return () => { cancelled = true }
  }, [])

  // Closes the tag-suggestions dropdown on an outside click, and - since
  // it's rendered inline in the form rather than position:fixed off a
  // captured bounding rect - also on scroll/resize, matching how the
  // other floating menus in this app (ColumnFilter, the strategy ⋮ menu)
  // dismiss rather than drift out of place.
  const tagDropdownRef = useClickOutside(showSuggestions, () => setShowSuggestions(false))
  useEffect(() => {
    if (!showSuggestions) return
    const dismiss = () => setShowSuggestions(false)
    // capture:true is what lets this see the dropdown's own scrollbar
    // scrolling (a native 'scroll' event doesn't bubble, so a plain
    // bubble-phase listener would never see it) - but that means it has to
    // explicitly ignore scrolls that originate inside the dropdown itself
    // (e.target is a real Node there, unlike resize's e.target === window),
    // or scrolling the 5-row suggestion list would close the very list
    // being scrolled.
    const dismissOnScroll = (e) => {
      if (tagDropdownRef.current && tagDropdownRef.current.contains(e.target)) return
      dismiss()
    }
    // The tag input is autoFocus'd, which on a real phone summons the
    // on-screen keyboard the instant this dropdown opens - and the
    // keyboard sliding up shrinks the visual viewport, firing a 'resize'
    // on most mobile browsers. A plain dismiss-on-any-resize closed the
    // dropdown before the user ever saw it. Width, unlike height, doesn't
    // change when a keyboard opens or closes - only on an actual
    // orientation change or window resize, which is what should still
    // dismiss it.
    const initialWidth = window.innerWidth
    const dismissOnResize = () => {
      if (window.innerWidth !== initialWidth) dismiss()
    }
    // The tag input is autoFocus'd, which can itself trigger a scroll-into-
    // view the instant the dropdown opens (e.g. a field near the viewport
    // edge). Deferring attachment by a frame lets that settle first, so
    // opening the dropdown doesn't immediately close itself.
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', dismissOnScroll, true)
      window.addEventListener('resize', dismissOnResize)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', dismissOnResize)
    }
  }, [showSuggestions])

  function updateSetup(field, value) {
    setDirty(true)
    setSetup((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
    // Entry price feeds the $ P&L calc - editing it is as much a signal to
    // resume auto-fill as editing contracts/exit price below, on the edit
    // page just as much as the new-trade page.
    if (field === 'entry') setPnlManual(false)
  }

  function updateExecution(field, value) {
    setDirty(true)
    setExecution((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
    // Editing any input the $ P&L calc actually depends on re-enables
    // auto-fill from that point on, even on the edit page where a stored
    // figure otherwise counts as manual (see pnlManual's init above) -
    // deliberately changing contracts or exit price is a clearer signal
    // that the trader wants the total to follow than a value that just
    // happens to still be sitting in the field from before.
    if (field === 'contracts' || field === 'exit_price') setPnlManual(false)
  }

  function handleDirectionChange(value) {
    setDirty(true)
    setDirection(value)
    setPnlManual(false)
  }

  async function handleAddStrategy(e) {
    e.preventDefault()
    if (!newStrategyName.trim()) return
    setFormError(null)
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('strategies')
      .insert([{ user_id: user.id, instrument_id: instrumentId, name: newStrategyName.trim() }])
      .select()
      .single()
    if (error) {
      setFormError(error.message)
      return
    }
    setNewStrategyName('')
    setAddingStrategy(false)
    await onStrategyAdded?.()
    setDirty(true)
    setStrategyId(data.id)
    setErrors((prev) => ({ ...prev, strategy: undefined }))
  }

  function handleScreenshotChange(e) {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setDirty(true)
    setScreenshots((prev) => [
      ...prev,
      ...files.map((file) => ({ file, previewUrl: URL.createObjectURL(file) })),
    ])
    // Reset so picking the same file again still fires a change event.
    e.target.value = ''
  }

  // Fires on paste anywhere in the form, not just the file input - a
  // screenshot copied from a snipping tool is usually pasted with focus
  // wherever the trader last clicked, not after hunting down "Choose
  // files" first. Only acts when the clipboard actually holds image data,
  // so pasting text into any other field (price, reasoning, a tag) is
  // completely unaffected.
  function handlePaste(e) {
    const items = e.clipboardData?.items
    if (!items) return
    const files = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length === 0) return
    e.preventDefault()
    setDirty(true)
    setScreenshots((prev) => [
      ...prev,
      ...files.map((file) => ({ file, previewUrl: URL.createObjectURL(file) })),
    ])
  }

  function handleRemoveScreenshot(index) {
    setDirty(true)
    setScreenshots((prev) => {
      const target = prev[index]
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

  function handleRemoveExistingScreenshot(index) {
    setDirty(true)
    setExistingScreenshots((prev) => prev.filter((_, i) => i !== index))
  }

  // Tags live entirely in local state until the whole form saves - unlike
  // strategies, there's no shared list to insert into, so adding one is
  // just an array update. The input stays open after adding (rather than
  // closing like "+ Add new strategy" does) since tagging a trade with
  // several words in a row is the common case. `tagText` lets a suggestion
  // click add that tag directly, without going through the input at all.
  function handleAddTag(tagText) {
    const trimmed = (tagText ?? newTagName).trim()
    if (!trimmed) return
    setDirty(true)
    setTags((prev) => (prev.some((t) => t.toLowerCase() === trimmed.toLowerCase()) ? prev : [...prev, trimmed]))
    setNewTagName('')
  }

  // Enter would otherwise submit the whole trade form, since this input
  // lives inside it - same reason "+ Add new strategy" uses a type="button".
  function handleTagKeyDown(e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    handleAddTag()
  }

  function handleRemoveTag(tag) {
    setDirty(true)
    setTags((prev) => prev.filter((t) => t !== tag))
  }

  function handlePnlFocus() {
    const parsed = parseCurrency(pnlInput)
    setPnlInput(parsed === null ? '' : String(parsed))
  }

  function handlePnlChange(value) {
    setDirty(true)
    setPnlInput(value)
    // Clearing the field hands control back to the auto-calculation.
    setPnlManual(!isBlank(value))
  }

  function handlePnlBlur() {
    const parsed = parseCurrency(pnlInput)
    setPnlInput(parsed === null ? '' : formatCurrency(parsed))
  }

  // Puts every piece of form state back exactly where it started, rather
  // than navigating away - the trader stays on the edit page with the
  // saved trade's original values restored. Screenshots picked since
  // mount get their object URLs revoked like unmount cleanup does, since
  // discarding drops them the same way closing the page would.
  function handleDiscard() {
    setStrategyId(initial.strategyId)
    setDirection(initial.direction)
    setSetup(initial.setup)
    setExecution(initial.execution)
    setPnlInput(initial.pnl == null ? '' : formatCurrency(initial.pnl))
    setPnlManual(initial.pnl != null && (initialComputed === null || Math.abs(initialComputed - initial.pnl) > 0.005))
    setExistingScreenshots(initial.existingScreenshots)
    setScreenshots((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.previewUrl))
      return []
    })
    setTags(initial.tags || [])
    setErrors({})
    setFormError(null)
    if (reasoningRef.current) reasoningRef.current.value = initial.reasoning
    setDirty(false)
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
    setFormError(null)
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
      entry: toDecimalString(entry),
      stop: toDecimalString(stopPrice),
      target: toDecimalString(targetPrice),
      stop_distance: toDecimalString(stopDistance),
      target_distance: toDecimalString(targetDistance),
      exit_price: toDecimalString(exitPrice),
      exit_time: execution.exit_time || null,
      r_multiple: calcRMultiple(direction, entry, stopPrice, exitPrice),
      reasoning: form.reasoning.value.trim(),
      contracts: isBlank(execution.contracts) ? null : parseInt(execution.contracts),
      pnl: toDecimalString(parseCurrency(pnlInput)),
      tags,
    }

    // The caller navigates away on success; returning an error message
    // string means it failed and the form should become editable again,
    // with that message shown instead of a native alert().
    const result = await onSubmit({ values, screenshots, existingScreenshots })
    if (typeof result === 'string') {
      setFormError(result)
      setSaving(false)
    }
  }

  // Previously-used tags, minus ones already on this trade, narrowed by
  // whatever's typed so far - shown as a dropdown under the tag input.
  const tagQuery = newTagName.trim().toLowerCase()
  const tagSuggestions = existingTags.filter((t) => (
    !tags.some((existing) => existing.toLowerCase() === t.toLowerCase())
    && (!tagQuery || t.toLowerCase().includes(tagQuery))
  ))

  return (
    <>
      <div className="panel">
        <form onSubmit={handleSubmit} onPaste={handlePaste} noValidate>

          {formError && (
            <div className="field full">
              <ErrorBanner message={formError} />
            </div>
          )}

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
              <select value={strategyId} onChange={(e) => { setDirty(true); setStrategyId(e.target.value); setErrors((prev) => ({ ...prev, strategy: undefined })) }}>
                {strategyId === '' && <option value="">Select a strategy…</option>}
                {strategies.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
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
                <div className="instrument-add-form-actions">
                  <span className="del" onClick={() => { setAddingStrategy(false); setNewStrategyName('') }}>Cancel</span>
                  <button type="button" onClick={handleAddStrategy}>Add</button>
                </div>
              </div>
            ) : (
              <span className="del" style={{ color: 'var(--accent)' }} onClick={() => setAddingStrategy(true)}>
                + Add new strategy
              </span>
            )}
          </div>
          <div className="field half">
            <label>Date</label>
            <DatePicker
              min={MIN_TRADE_DATE} max={todayStr}
              value={setup.trade_date} onChange={(v) => updateSetup('trade_date', v)}
            />
            {errors.trade_date && <span className="field-error">{errors.trade_date}</span>}
          </div>

          <div className="field wide">
            <label>Entry time (to the second)</label>
            <TimePicker
              value={setup.trade_time} onChange={(v) => updateSetup('trade_time', v)}
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
              <div className={`dir-btn ${direction === 'long' ? 'active-long' : ''}`} onClick={() => handleDirectionChange('long')}>Long</div>
              <div className={`dir-btn ${direction === 'short' ? 'active-short' : ''}`} onClick={() => handleDirectionChange('short')}>Short</div>
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
            <input type="text" readOnly tabIndex={-1} className="readonly-field" value={riskReward === null ? '—' : riskReward.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
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
            <TimePicker
              value={execution.exit_time} onChange={(v) => updateExecution('exit_time', v)}
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
            <label>Screenshot(s) <FieldTooltip text={SCREENSHOT_PASTE_HINT} /></label>
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

          <div className="field full tags-field">
            <div className="tag-row">
              {tags.map((tag) => (
                <span className="trade-tag" key={tag}>
                  {tag}
                  <X size={12} className="trade-tag-remove" onClick={() => handleRemoveTag(tag)} />
                </span>
              ))}
              {addingTag ? (
                <span className="tag-add-form-wrap" ref={tagDropdownRef}>
                  <span className="tag-add-form">
                    <input
                      type="text" placeholder="Tag name" autoFocus
                      value={newTagName}
                      onChange={(e) => { setNewTagName(e.target.value); setShowSuggestions(true) }}
                      onFocus={() => setShowSuggestions(true)}
                      onKeyDown={handleTagKeyDown}
                    />
                    <span className="del" style={{ color: 'var(--accent)' }} onClick={() => handleAddTag()}>Add</span>
                  </span>
                  {showSuggestions && tagSuggestions.length > 0 && (
                    <div className="tag-suggestions">
                      {tagSuggestions.map((t) => (
                        <div key={t} className="tag-suggestion-item" onClick={() => handleAddTag(t)}>{t}</div>
                      ))}
                    </div>
                  )}
                </span>
              ) : (
                <span className="del" style={{ color: 'var(--accent)' }} onClick={() => { setAddingTag(true); setShowSuggestions(true) }}>
                  + Add tag
                </span>
              )}
            </div>
          </div>

          <div className="field full">
            <textarea
              ref={reasoningRef}
              name="reasoning"
              defaultValue={initial.reasoning}
              aria-label="Why did you take it?"
              onChange={() => setDirty(true)}
            />
          </div>

          <div className="submit-row" style={footerLeft ? { justifyContent: 'space-between' } : undefined}>
            {footerLeft}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              {allowDiscard && dirty && (
                <button type="button" className="discard-btn" onClick={handleDiscard} disabled={saving}>
                  Discard changes
                </button>
              )}
              <button type="submit" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
            </div>
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
