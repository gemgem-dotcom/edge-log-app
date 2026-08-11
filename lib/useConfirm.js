'use client'

import { useState, useCallback, useRef } from 'react'

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

  function settle(result) {
    resolveRef.current?.(result)
    resolveRef.current = null
    setRequest(null)
  }

  const modal = request && (
    <div className="confirm-modal-overlay" onClick={() => settle(false)}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{request.title}</h2>
        <p>{request.message}</p>
        <div className="submit-row">
          <button type="button" className="btn-accent-outline" onClick={() => settle(false)}>Cancel</button>
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
