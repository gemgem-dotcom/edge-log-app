'use client'

import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { subscribeToast } from '@/lib/toast'

const DISMISS_AFTER_MS = 3500
// Must match the .toast-leaving animation duration in globals.css, so the
// toast is only removed from the DOM once its fade-out has finished.
const EXIT_MS = 200

// Mounted once in the root layout so it survives client-side navigation
// between pages - a toast fired right before a router.push still gets seen.
export default function ToastContainer() {
  const [toasts, setToasts] = useState([])

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
