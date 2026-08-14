'use client'

import { useState, useEffect } from 'react'
import { marketStatus } from '@/lib/marketHours'

// Starts null (renders nothing) rather than computing eagerly, since the
// server has no timezone-correct notion of "now" - avoids a hydration
// mismatch, then fills in on mount from the browser's clock.
export default function MarketStatusPill() {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    setStatus(marketStatus())
    const id = setInterval(() => setStatus(marketStatus()), 60000)
    return () => clearInterval(id)
  }, [])

  if (status === null) return null
  return (
    <div className={`market-status-pill ${status.open ? 'market-status-pill-open' : 'market-status-pill-closed'}`}>
      <span className="market-status-dot" />
      {status.label}
    </div>
  )
}
