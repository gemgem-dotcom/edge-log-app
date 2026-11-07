'use client'

import { useState, useCallback, useRef, useEffect } from 'react'

// In-app replacement for window.confirm() - the browser's own dialog reads
// as broken next to the rest of the platform's styling, so this renders
// the same .confirm-modal used by the Delete Account / delete strategy
// modals instead. await confirm({...}) resolves true/false exactly like
// the native call did, so call sites barely change; render {modal}
// somewhere in the component's JSX to actually show it.
export function useConfirm() {
  const [request, setRequest] = useState(null)
  const resolveRef = useRef(null)

  const confirm = useCallback(({ title, message, confirmLabel = 'Confirm', danger = false }) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setRequest({ title, message, confirmLabel, danger })
    })
  }, [])

  const settle = useCallback((result) => {
    resolveRef.current?.(result)
    resolveRef.current = null
    setRequest(null)
  }, [])

  // Escape cancels, and the confirm button takes focus when the dialog
  // opens. Neither was true before: the only way out was clicking, and
  // pressing Escape - which is what people do - did nothing at all,
  // which reads as a frozen app on a dialog that is usually asking
  // about something destructive.
  useEffect(() => {
    if (!request) return undefined
    const onKey = (e) => { if (e.key === 'Escape') settle(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [request, settle])

  const modal = request && (
    <div className="confirm-modal-overlay" onClick={() => settle(false)}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{request.title}</h2>
        <p>{request.message}</p>
        <div className="submit-row">
          {/* Focus lands on Cancel, not on the destructive action - a
              stray Enter should not confirm a deletion. */}
          <button type="button" className="btn-accent-outline" autoFocus onClick={() => settle(false)}>Cancel</button>
          {/* Destructive actions get the same red outline style as the
              Delete Account / delete strategy modals; anything else falls
              back to the plain solid-accent button used for primary form
              actions elsewhere (Save changes, Update password), so Confirm
              still reads as the primary action without implying danger. */}
          <button
            type="button"
            className={request.danger ? 'btn-danger-outline' : undefined}
            onClick={() => settle(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )

  return { confirm, modal }
}
