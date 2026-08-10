'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { usePageTitle } from '@/lib/usePageTitle'

export default function NotFound() {
  usePageTitle('Page Not Found')
  const [href, setHref] = useState('/login')
  const [label, setLabel] = useState('Back to login')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setHref('/app')
        setLabel('Back to dashboard')
      }
    })
  }, [])

  return (
    <div className="auth-wrap">
      <div className="state-card">
        <div className="auth-logo" style={{ marginBottom: '18px' }}>Edge<span>Log</span></div>
        <div className="state-code">404</div>
        <div className="state-title">Page not found</div>
        <p className="state-message">
          The page you're looking for doesn't exist, or may have moved.
        </p>
        <div className="state-actions">
          <a href={href} className="new-trade-btn" style={{ display: 'inline-flex' }}>{label}</a>
        </div>
      </div>
    </div>
  )
}
