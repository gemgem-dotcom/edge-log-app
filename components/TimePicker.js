'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Clock } from 'lucide-react'
import { useClickOutside } from '../lib/useClickOutside'

function pad(n) { return String(n).padStart(2, '0') }

// value is 24-hour "HH:MM:SS" - the same format the native
// input[type=time] this replaces stored, so tradeDurationMinutes and
// everything else reading trade_time/exit_time needed no changes. Trades
// logged before step="1" existed only stored "HH:MM", so seconds isn't
// just possibly NaN (a bad 3rd segment) but possibly missing entirely -
// Number.isNaN(undefined) is false, so that alone won't catch it.
function parseTime(value) {
  if (!value) return null
  const [h, m, s] = value.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return { h, m, s: Number.isFinite(s) ? s : 0 }
}

function to12Hour(h) {
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return { h12, period }
}

function from12Hour(h12, period) {
  const h = h12 % 12
  return period === 'PM' ? h + 12 : h
}

function formatDisplay(value) {
  const t = parseTime(value)
  if (!t) return ''
  const { h12, period } = to12Hour(t.h)
  return `${pad(h12)}:${pad(t.m)}:${pad(t.s)} ${period}`
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)
const SIXTY = Array.from({ length: 60 }, (_, i) => i)

export default function TimePicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(open, useCallback(() => setOpen(false), []))
  const hourColRef = useRef(null)
  const minColRef = useRef(null)
  const secColRef = useRef(null)

  const parsed = parseTime(value)
  const { h12, period } = parsed ? to12Hour(parsed.h) : { h12: null, period: null }
  const minute = parsed ? parsed.m : null
  const second = parsed ? parsed.s : null

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    const dismissOnScroll = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      dismiss()
    }
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', dismissOnScroll, true)
      window.addEventListener('resize', dismiss)
      // Scroll each column so the current value (or a sane default) is
      // in view instead of opening on hour "01".
      ;[hourColRef, minColRef, secColRef].forEach((colRef) => {
        const el = colRef.current?.querySelector('.dt-picker-col-active')
        if (el) el.scrollIntoView({ block: 'center' })
      })
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', dismissOnScroll, true)
      window.removeEventListener('resize', dismiss)
    }
    // Deliberately only [open] - re-running this per keystroke would yank
    // the columns' scroll position while the trader is still clicking
    // through hour/minute/second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function commit(next) {
    onChange(`${pad(next.h)}:${pad(next.m)}:${pad(next.s)}`)
  }

  // Any segment clicked before the others starts from a plain default
  // (12:00:00 AM) rather than requiring every column to be set in order.
  const base = parsed || { h: 0, m: 0, s: 0 }

  function setHour12(newH12) {
    commit({ ...base, h: from12Hour(newH12, parsed ? period : 'AM') })
  }
  function setMinute(m) {
    commit({ ...base, m })
  }
  function setSecond(s) {
    commit({ ...base, s })
  }
  function setPeriod(p) {
    commit({ ...base, h: from12Hour(parsed ? h12 : 12, p) })
  }

  return (
    <div className="dt-picker" ref={ref}>
      <div className="dt-picker-trigger">
        <span className={value ? '' : 'dt-picker-placeholder'}>{value ? formatDisplay(value) : '--:--:-- --'}</span>
        <button type="button" className="dt-picker-icon-btn" aria-label="Open time picker" onClick={() => setOpen((v) => !v)}>
          <Clock size={15} />
        </button>
      </div>
      {open && (
        <div className="dt-picker-popup dt-picker-popup-time">
          <div className="dt-picker-time-cols">
            <div className="dt-picker-col" ref={hourColRef}>
              {HOURS.map((h) => (
                <div key={h} className={`dt-picker-col-item ${h12 === h ? 'dt-picker-col-active' : ''}`} onClick={() => setHour12(h)}>{pad(h)}</div>
              ))}
            </div>
            <div className="dt-picker-col" ref={minColRef}>
              {SIXTY.map((m) => (
                <div key={m} className={`dt-picker-col-item ${minute === m ? 'dt-picker-col-active' : ''}`} onClick={() => setMinute(m)}>{pad(m)}</div>
              ))}
            </div>
            <div className="dt-picker-col" ref={secColRef}>
              {SIXTY.map((s) => (
                <div key={s} className={`dt-picker-col-item ${second === s ? 'dt-picker-col-active' : ''}`} onClick={() => setSecond(s)}>{pad(s)}</div>
              ))}
            </div>
            <div className="dt-picker-col dt-picker-col-period">
              <div className={`dt-picker-col-item ${period === 'AM' ? 'dt-picker-col-active' : ''}`} onClick={() => setPeriod('AM')}>AM</div>
              <div className={`dt-picker-col-item ${period === 'PM' ? 'dt-picker-col-active' : ''}`} onClick={() => setPeriod('PM')}>PM</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
