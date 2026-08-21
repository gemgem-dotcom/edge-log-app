'use client'

import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { queueToastForReturn } from '../lib/toast'
import { calcStopPrice, calcTargetPrice, calcRMultiple, calcRiskReward, calcMultiExitProfitLoss, calcExitPriceFromPoints } from '../lib/tradeMath'
import { isBlank, validateSetup, validateExecution, validateDiscipline, parseCurrency, formatCurrency, toDecimalString, todayDateString, MIN_TRADE_DATE } from '../lib/tradeForm'
import { pointValueFor } from '../lib/instrumentCatalog'
import { useClickOutside } from '../lib/useClickOutside'
import FieldTooltip from './FieldTooltip'
import ErrorBanner from './ErrorBanner'
import DatePicker from './DatePicker'
import TimePicker from './TimePicker'
import ScreenshotLightbox from './ScreenshotLightbox'

const DISTANCE_HINT = 'This is the figure shown on your position/long-short tool — the raw point distance from entry, not ticks or dollars.'
const EXIT_POINTS_HINT = 'Points gained or lost on this exit, relative to your entry price. A loss is a negative number (e.g. -5 for a 5-point loss) — a gain is positive.'

// Fixed, grouped issue list for the Discipline field below - unlike Tags,
// this isn't a free-text/previously-used list, so the groups and their order
// are just declared here.
const DISCIPLINE_GROUPS = [
  { heading: 'Entry discipline', items: ['Early entry', 'Chased price / late entry', 'No clear setup'] },
  { heading: 'Risk management', items: ['Oversized', 'Moved stop', 'Removed stop'] },
  { heading: 'Exit discipline', items: ['Cut winner early', 'Held loser too long', 'Moved target'] },
  { heading: 'Behavioral', items: ['Hesitated', 'Revenge trade', 'Overtraded'] },
]

export const EMPTY_TRADE_FORM = {
  direction: 'long',
  strategyId: '',
  reasoning: '',
  setup: { trade_date: '', trade_time: '', entry: '', target_distance: '', stop_distance: '' },
  execution: { contracts: '', exit_time: '', exit_points: '' },
  additionalExits: [],
  pnl: null,
  tags: [],
  reviewedNoIssues: false,
  disciplineTags: [],
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
  onCancel = null,
  onSubmit,
}) {
  // Only the edit-trade page passes allowDiscard - dirty just picks the
  // label on the button that leaves the page (Cancel vs Discard changes,
  // see onCancel below), so it's not worth tracking anywhere else.
  const [dirty, setDirty] = useState(false)

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
  const initialEntry = parseFloat(initial.setup.entry)
  const initialExitRows = [
    { exit_price: calcExitPriceFromPoints(initial.direction, initialEntry, parseFloat(initial.execution.exit_points)), contracts: parseFloat(initial.execution.contracts) },
    ...(initial.additionalExits || []).map((e) => ({ exit_price: calcExitPriceFromPoints(initial.direction, initialEntry, parseFloat(e.exit_points)), contracts: parseFloat(e.contracts) })),
  ]
  const initialComputed = calcMultiExitProfitLoss(
    initial.direction,
    initialEntry,
    initialExitRows,
    pointValueFor(symbol),
  )
  const [pnlManual, setPnlManual] = useState(
    initial.pnl != null && (initialComputed === null || Math.abs(initialComputed - initial.pnl) > 0.005)
  )

  // Multiple exits: the primary exit (execution.exit_time/exit_points/
  // contracts above) is always exit #1 - additionalExits holds only the
  // rows beyond that, each the same shape. Starting multipleExits true
  // whenever a loaded trade already has any is what lets the edit page
  // show the numbered list instead of collapsing real data down to a
  // single row.
  const [multipleExits, setMultipleExits] = useState((initial.additionalExits || []).length > 0)
  const [additionalExits, setAdditionalExits] = useState(initial.additionalExits || [])

  const [existingScreenshots, setExistingScreenshots] = useState(initial.existingScreenshots)
  const [screenshots, setScreenshots] = useState([])
  // Index into the combined existingScreenshots + screenshots list below
  // (in that same order) rather than a URL, so ScreenshotLightbox - shared
  // with the read-only Trade Detail page and Trade Log's expand row - can
  // step between them with its arrows/keyboard nav the same way there.
  const [lightboxIndex, setLightboxIndex] = useState(null)

  const [tags, setTags] = useState(initial.tags || [])
  const [addingTag, setAddingTag] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [existingTags, setExistingTags] = useState([])
  // Separate from addingTag, which keeps the tag input itself open - this
  // only governs the suggestions dropdown, so scrolling or clicking away
  // closes the dropdown without losing whatever's mid-typed in the input.
  const [showSuggestions, setShowSuggestions] = useState(false)

  const [reviewedNoIssues, setReviewedNoIssues] = useState(initial.reviewedNoIssues ?? false)
  const [disciplineTags, setDisciplineTags] = useState(initial.disciplineTags || [])
  const [showDisciplineMenu, setShowDisciplineMenu] = useState(false)

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

  // Auto-fill $ P&L from every exit - each one closes its own contracts at
  // its own price (see calcMultiExitProfitLoss), so this is the same
  // calculation whether there's one exit or several; additionalExits is
  // always empty outside multiple-exits mode, so the single-exit case just
  // falls out of it rather than needing its own branch. Each exit's own
  // price is derived from its typed points figure (calcExitPriceFromPoints)
  // rather than read directly, same as at submit time.
  useEffect(() => {
    if (pnlManual) return
    const entryNum = parseFloat(setup.entry)
    const exitRows = [
      { exit_price: calcExitPriceFromPoints(direction, entryNum, parseFloat(execution.exit_points)), contracts: parseFloat(execution.contracts) },
      ...additionalExits.map((e) => ({ exit_price: calcExitPriceFromPoints(direction, entryNum, parseFloat(e.exit_points)), contracts: parseFloat(e.contracts) })),
    ]
    const computed = calcMultiExitProfitLoss(direction, entryNum, exitRows, pointValueFor(symbol))
    setPnlInput(computed === null ? '' : formatCurrency(computed))
  }, [pnlManual, direction, setup.entry, execution.exit_points, execution.contracts, additionalExits, symbol])

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

  // Discipline's issue picker is a plain click-to-toggle list, not a typed
  // input like the tag dropdown above - no autofocus/keyboard/scroll
  // interplay to guard against, so a plain outside-click close is enough.
  const disciplineMenuRef = useClickOutside(showDisciplineMenu, () => setShowDisciplineMenu(false))

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
    // deliberately changing contracts or exit points is a clearer signal
    // that the trader wants the total to follow than a value that just
    // happens to still be sitting in the field from before.
    if (field === 'contracts' || field === 'exit_points') setPnlManual(false)
  }

  function handleDirectionChange(value) {
    setDirty(true)
    setDirection(value)
    setPnlManual(false)
  }

  // Ticking on seeds one blank extra row (exit #2) so the numbered list has
  // something to show right away, rather than a checkbox with nothing
  // under it. Ticking off drops every extra row rather than just hiding
  // them - same as unchecking Discipline's own reviewed box back on, there
  // should be nothing left over to reappear if it's ticked on again later.
  function handleMultipleExitsToggle(checked) {
    setDirty(true)
    setMultipleExits(checked)
    if (checked) {
      setAdditionalExits((prev) => (prev.length > 0 ? prev : [{ exit_time: '', exit_points: '', contracts: '' }]))
    } else {
      setAdditionalExits([])
    }
    setPnlManual(false)
  }

  function handleAddAnotherExit() {
    setDirty(true)
    setAdditionalExits((prev) => [...prev, { exit_time: '', exit_points: '', contracts: '' }])
  }

  function handleRemoveAdditionalExit(index) {
    setDirty(true)
    setAdditionalExits((prev) => {
      const next = prev.filter((_, i) => i !== index)
      // Back down to just the primary exit - the numbered list/indent only
      // makes sense with more than one, so drop back to the plain single-
      // row layout rather than leaving the checkbox checked over a list of
      // exactly one.
      if (next.length === 0) setMultipleExits(false)
      return next
    })
    setPnlManual(false)
  }

  function updateAdditionalExit(index, field, value) {
    setDirty(true)
    setAdditionalExits((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
    if (field === 'contracts' || field === 'exit_points') setPnlManual(false)
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

  function handleReviewedChange(checked) {
    setDirty(true)
    setReviewedNoIssues(checked)
    setErrors((prev) => (prev.discipline ? { ...prev, discipline: undefined } : prev))
  }

  // The issue list is fixed, so toggling is just in/out - unlike free-text
  // tags there's nothing to dedupe or trim.
  function handleToggleDisciplineTag(tag) {
    setDirty(true)
    setDisciplineTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
    setErrors((prev) => (prev.discipline ? { ...prev, discipline: undefined } : prev))
  }

  function handleRemoveDisciplineTag(tag) {
    setDirty(true)
    setDisciplineTags((prev) => prev.filter((t) => t !== tag))
  }

  // The same button reads "Cancel" or "Discard changes" depending on
  // `dirty` (see the button below) - only the latter is an action worth a
  // toast, since "Cancel" means there was nothing to throw away.
  function handleCancelClick() {
    if (dirty) queueToastForReturn('Changes discarded.')
    onCancel()
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

  async function handleSubmit(e) {
    e.preventDefault()

    const foundErrors = {
      ...validateSetup({ ...setup, direction, strategyId }),
      ...validateExecution(execution),
      ...validateDiscipline({ reviewedNoIssues, disciplineTags }),
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
    const exitPoints = parseFloat(execution.exit_points)
    const exitPrice = calcExitPriceFromPoints(direction, entry, exitPoints)
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
      // exit_price is derived from exit_points (the trader's own typed
      // figure, kept alongside it) rather than entered directly - see
      // calcExitPriceFromPoints. r_multiple/$-P&L/everything else downstream
      // still runs on this real price exactly as before.
      exit_price: toDecimalString(exitPrice),
      exit_points: toDecimalString(exitPoints),
      exit_time: execution.exit_time || null,
      r_multiple: calcRMultiple(direction, entry, stopPrice, exitPrice),
      reasoning: form.reasoning.value.trim(),
      contracts: isBlank(execution.contracts) ? null : parseInt(execution.contracts),
      // Rows the trader added but left entirely untouched (e.g. clicked
      // "+ Add another exit" then changed their mind) are dropped rather
      // than saved as empty placeholders.
      additional_exits: multipleExits
        ? additionalExits
          .filter((row) => !(isBlank(row.exit_time) && isBlank(row.exit_points) && isBlank(row.contracts)))
          .map((row) => {
            const points = parseFloat(row.exit_points)
            return {
              exit_time: row.exit_time || null,
              exit_points: toDecimalString(points),
              exit_price: toDecimalString(calcExitPriceFromPoints(direction, entry, points)),
              contracts: isBlank(row.contracts) ? null : parseInt(row.contracts),
            }
          })
        : [],
      pnl: toDecimalString(parseCurrency(pnlInput)),
      tags,
      reviewed_no_issues: reviewedNoIssues,
      discipline_tags: reviewedNoIssues ? [] : disciplineTags,
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

  // Same order as the two .map() calls in the screenshot grid below, so a
  // thumbnail's lightboxIndex (set on click) always points at the matching
  // image here.
  const allScreenshotUrls = [...existingScreenshots, ...screenshots.map((s) => s.previewUrl)]

  // The same three fields (Exit time / Exit (in points) / Contracts)
  // whether this is the trade's only exit or one of several - idx 0 is
  // always the primary exit (execution state, exit_points validated
  // below), idx 1+ are additionalExits rows. Kept as one function rather
  // than duplicating the JSX so the two only ever drift apart in their
  // data source, never their fields or field order.
  function renderExitFields(idx) {
    const isPrimary = idx === 0
    const row = isPrimary ? execution : additionalExits[idx - 1]
    const update = isPrimary
      ? (field, value) => updateExecution(field, value)
      : (field, value) => updateAdditionalExit(idx - 1, field, value)
    return (
      <>
        <div className="field wide">
          <label>Exit time (to the second)</label>
          <TimePicker value={row.exit_time} onChange={(v) => update('exit_time', v)} />
        </div>
        <div className="field wide">
          <label>Exit (in points) <FieldTooltip text={EXIT_POINTS_HINT} /></label>
          <input
            type="number" step="0.01"
            value={row.exit_points} onChange={(e) => update('exit_points', e.target.value)}
          />
          {isPrimary && errors.exit_points && <span className="field-error">{errors.exit_points}</span>}
        </div>
        <div className="field wide">
          <label>Contracts</label>
          <input
            type="number" step="1"
            value={row.contracts} onChange={(e) => update('contracts', e.target.value)}
          />
        </div>
      </>
    )
  }

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
              These details define the setup and help EdgeLog identify it in market data. Record the trade as your strategy says it should be taken.
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
            <label>Stop Loss (in points) <FieldTooltip text={DISTANCE_HINT} /></label>
            <input
              type="number" step="0.01" min="0"
              value={setup.stop_distance} onChange={(e) => updateSetup('stop_distance', e.target.value)}
            />
            {errors.stop_distance && <span className="field-error">{errors.stop_distance}</span>}
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
            <label>Risk-to-Reward</label>
            <input type="text" disabled className="readonly-field" value={riskReward === null ? '—' : riskReward.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          </div>

          <div className="field full section-label">
            Trade Execution
            <span className="section-subtitle">
              Record how the trade was executed, including contracts, exit details, and your final P&amp;L.
            </span>
          </div>

          <div className="field full">
            <div className="checkbox-label">
              <input
                type="checkbox"
                checked={multipleExits}
                onChange={(e) => handleMultipleExitsToggle(e.target.checked)}
                aria-label="Multiple exits"
              />
              Multiple exits
            </div>
          </div>

          {!multipleExits ? (
            renderExitFields(0)
          ) : (
            <div className="field full">
              <ol className="exit-list">
                <li className="exit-list-item">
                  <div className="exit-row-fields">{renderExitFields(0)}</div>
                </li>
                {additionalExits.map((_, i) => (
                  <li className="exit-list-item" key={i}>
                    <div className="exit-row-fields">{renderExitFields(i + 1)}</div>
                    <span className="del exit-remove" onClick={() => handleRemoveAdditionalExit(i)}>Remove this exit</span>
                  </li>
                ))}
              </ol>
              <span className="del exit-add" style={{ color: 'var(--accent)' }} onClick={handleAddAnotherExit}>
                + Add another exit
              </span>
            </div>
          )}

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
          <div className="field full section-label">
            Trade Review
            <span className="section-subtitle">
              Review your trade, record your observations, and identify areas for improvement.
            </span>
          </div>

          <div className="field full tags-field">
            <label>Tags</label>
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

          <div className="field full discipline-field">
            <label>Discipline</label>
            {/* A div, not a label - a native <label> toggles its checkbox
                on a click anywhere in it, including the text, which isn't
                wanted for any checkbox in this form (see Multiple exits
                below, the same way). aria-label restores what the checkbox
                loses by not being wrapped in one. */}
            <div className="checkbox-label">
              <input
                type="checkbox"
                checked={reviewedNoIssues}
                onChange={(e) => handleReviewedChange(e.target.checked)}
                aria-label="Reviewed — no issues"
              />
              Reviewed — no issues
            </div>

            {!reviewedNoIssues && (
              <div className="tag-row discipline-tag-row">
                {disciplineTags.map((tag) => (
                  <span className="trade-tag discipline-tag" key={tag}>
                    {tag}
                    <X size={12} className="trade-tag-remove" onClick={() => handleRemoveDisciplineTag(tag)} />
                  </span>
                ))}
                <span className="discipline-menu-wrap" ref={disciplineMenuRef}>
                  <span className="del" style={{ color: 'var(--loss)' }} onClick={() => setShowDisciplineMenu((v) => !v)}>
                    + Add issue
                  </span>
                  {showDisciplineMenu && (
                    <div className="discipline-menu">
                      {DISCIPLINE_GROUPS.map((group) => {
                        const remaining = group.items.filter((item) => !disciplineTags.includes(item))
                        if (remaining.length === 0) return null
                        return (
                          <div key={group.heading}>
                            <div className="discipline-menu-heading">{group.heading}</div>
                            {remaining.map((item) => (
                              <div
                                key={item}
                                className="discipline-menu-item"
                                onClick={() => handleToggleDisciplineTag(item)}
                              >
                                {item}
                              </div>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </span>
              </div>
            )}
            {errors.discipline && <span className="field-error">{errors.discipline}</span>}
          </div>

          <div className="field full">
            <label>Notes</label>
            <textarea
              name="reasoning"
              defaultValue={initial.reasoning}
              aria-label="Why did you take it?"
              onChange={() => setDirty(true)}
            />
          </div>

          <div className="field full">
            <label>Screenshot(s)</label>
            <div className="screenshot-upload-row">
              <label htmlFor="screenshot-upload" className="file-upload-btn">Choose files</label>
              <input
                id="screenshot-upload"
                type="file" accept="image/*" multiple
                onChange={handleScreenshotChange}
                className="file-upload-input"
              />
              <span className="field-hint">or paste from clipboard</span>
            </div>
            {(existingScreenshots.length > 0 || screenshots.length > 0) && (
              <div className="screenshot-grid">
                {existingScreenshots.map((url, i) => (
                  <div key={url} className="screenshot-preview-wrap">
                    <img
                      src={url}
                      alt={`Screenshot ${i + 1}`}
                      className="screenshot-preview-thumb"
                      onClick={() => setLightboxIndex(i)}
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
                      onClick={() => setLightboxIndex(existingScreenshots.length + i)}
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

          <div className="submit-row" style={footerLeft ? { justifyContent: 'space-between' } : undefined}>
            {footerLeft}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              {allowDiscard && onCancel && (
                <button type="button" className={`discard-btn${dirty ? ' dirty' : ''}`} onClick={handleCancelClick} disabled={saving}>
                  {dirty ? 'Discard changes' : 'Cancel'}
                </button>
              )}
              <button type="submit" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
            </div>
          </div>
        </form>
      </div>

      {lightboxIndex !== null && (
        <ScreenshotLightbox
          shots={allScreenshotUrls}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  )
}
