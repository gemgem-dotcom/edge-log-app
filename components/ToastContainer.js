'use client'

import { useState, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { CheckCircle2, XCircle } from 'lucide-react'
import { subscribeToast, takeQueuedReturnToast } from '@/lib/toast'

const DISMISS_AFTER_MS = 3500
// Must match the .toast-leaving animation duration in globals.css, so the
// toast is only removed from the DOM once its fade-out has finished.
const EXIT_MS = 200

// Mounted once in the root layout so it survives client-side navigation
// between pages - a toast fired right before a router.push still gets seen.
export default function ToastContainer() {
  const [toasts, setToasts] = useState([])
  const pathname = usePathname()

  const remove = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const startLeaving = useCallback((id) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => remove(id), EXIT_MS)
  }, [remove])

  useEffect(() => {
    return subscribeToast((item) => {
      setToasts((prev) => [...prev, item])
      setTimeout(() => startLeaving(item.id), DISMISS_AFTER_MS)
    })
  }, [startLeaving])

  // Picks up a toast queued right before a router.back() (see
  // queueToastForReturn's own comment). Keyed on pathname rather than a
  // plain mount effect: this component never actually unmounts across an
  // in-app navigation (it's rendered once from the root layout), so a
  // mount-only effect wouldn't reliably re-fire on the way back - pathname
  // changing is the one thing guaranteed to happen on every route change,
  // regardless of whether Next.js serves it from its router cache or not.
  useEffect(() => {
    const queued = takeQueuedReturnToast()
    if (!queued) return
    setToasts((prev) => [...prev, queued])
    setTimeout(() => startLeaving(queued.id), DISMISS_AFTER_MS)
  }, [pathname, startLeaving])

  if (toasts.length === 0) return null

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}${t.leaving ? ' toast-leaving' : ''}`}>
          {t.type === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
