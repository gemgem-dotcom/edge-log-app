'use client'

import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { easternParts } from '@/lib/marketHours'
import CME_HOLIDAYS from '@/lib/cmeHolidays.json'

// Calendar-date arithmetic on the ET date string itself (not "+24h" on a
// timestamp), so this can't land on the wrong day across a DST transition
// - noon avoids ever landing on a DST-shifted midnight edge case too.
function tomorrowEtDateStr() {
  const todayStr = easternParts(new Date()).dateStr
  const tomorrow = new Date(`${todayStr}T12:00:00`)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
}

function formatCloseTime(closeTime) {
  const [h, m] = closeTime.split(':').map(Number)
  const period = h >= 12 ? 'pm' : 'am'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')}${period}`
}

function dismissKey(dateStr) {
  return `dismissedHolidayNotice:${dateStr}`
}

// This is position:fixed (see globals.css) above the app shell's own
// fixed topbar, which otherwise has no way to know this banner exists -
// setting this shared height lets .shell-topbar/.account-topbar's `top`
// shift down to sit below it instead of being covered by it. Cleared
// (0px) whenever this isn't actually showing. The custom event is what
// lets useStickyTopbar's spacer react to that shift even though the
// topbar's own box never resizes - only its rendered position does.
function setSharedHeight(px) {
  document.documentElement.style.setProperty('--holiday-notice-height', `${px}px`)
  window.dispatchEvent(new Event('holidaynoticechange'))
}

// Banner for "markets closed/early-close tomorrow", reading the same
// static CME calendar lib/marketHours.js does. Renders nothing if
// tomorrow (ET) has no holiday entry, or the trader already dismissed
// *this specific* date's notice - dismissal is keyed by date in
// localStorage rather than a single flag, so dismissing this
// Thanksgiving's notice doesn't also suppress next month's holiday.
// Starts rendering nothing (not even a flash) since "tomorrow" and its
// dismissed state both depend on the browser's own clock/localStorage,
// which the server can't know - same reasoning as MarketStatusPill.
export default function HolidayNotice() {
  const [dateStr, setDateStr] = useState(null)
  const [dismissed, setDismissed] = useState(true)
  const noticeRef = useRef(null)

  useEffect(() => {
    const tomorrow = tomorrowEtDateStr()
    setDateStr(tomorrow)
    setDismissed(localStorage.getItem(dismissKey(tomorrow)) === '1')
  }, [])

  const holiday = dateStr ? CME_HOLIDAYS[dateStr] : null
  const visible = Boolean(dateStr && !dismissed && holiday)

  useEffect(() => {
    if (!visible || typeof ResizeObserver === 'undefined') {
      setSharedHeight(0)
      return
    }
    const el = noticeRef.current
    if (!el) return
    const measure = () => setSharedHeight(el.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      setSharedHeight(0)
    }
  }, [visible])

  if (!visible) return null

  function handleDismiss() {
    localStorage.setItem(dismissKey(dateStr), '1')
    setDismissed(true)
  }

  const message = holiday.type === 'closed'
    ? `Markets closed tomorrow for ${holiday.name}.`
    : `Early close tomorrow (${formatCloseTime(holiday.closeTime)} ET) for ${holiday.name}.`

  return (
    <div className="holiday-notice" ref={noticeRef}>
      <span>{message}</span>
      <button type="button" className="holiday-notice-dismiss" onClick={handleDismiss} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}
