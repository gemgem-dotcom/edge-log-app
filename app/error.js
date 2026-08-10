'use client'

import { useEffect } from 'react'

// Root error boundary - catches any runtime error thrown while rendering a
// page and shows this instead of Next.js's default broken-page screen.
// Deliberately has no data fetching of its own (no auth check, no Supabase
// calls) so it can't itself throw while trying to recover from an error.
export default function Error({ error, reset }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="auth-wrap">
      <div className="state-card">
        <div className="auth-logo" style={{ marginBottom: '18px' }}>Edge<span>Log</span></div>
        <div className="state-title">Something went wrong</div>
        <p className="state-message">
          An unexpected error occurred. You can try again, or head back to the dashboard.
        </p>
        <div className="state-actions">
          <button type="button" onClick={() => reset()}>Try again</button>
          <a href="/" className="btn-accent-outline" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  )
}
