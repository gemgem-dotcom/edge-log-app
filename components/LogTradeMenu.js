'use client'

import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { useClickOutside } from '@/lib/useClickOutside'

// "Log new trade" for the all-instruments Overview page, which - unlike
// every other page's copy of this button - has no single instrument to
// link straight to. Opens a short dropdown of the user's added
// instruments instead; picking one goes to that instrument's own Log New
// Trade page, the same destination the button reaches directly
// everywhere else. Always at least one instrument here - this page only
// ever renders once the user has added one (see app/app/page.js).
export default function LogTradeMenu({ instruments }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const menuRef = useClickOutside(open, close)

  // Dropdown isn't repositioned on scroll, so close it rather than let it
  // drift away from the button (same scroll-dismiss pattern as
  // InstrumentNav's "Add instrument" menu).
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      window.addEventListener('scroll', close, true)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, close])

  return (
    <div className="log-trade-menu-wrap" ref={menuRef}>
      <button type="button" className="new-trade-btn" onClick={() => setOpen((v) => !v)}>
        <Plus size={16} /> Log new trade
      </button>
      {open && (
        <div className="strategy-menu-dropdown log-trade-dropdown">
          {instruments.map((inst) => (
            <Link key={inst.id} href={`/app/${inst.symbol}/log/new`} className="strategy-menu-item">
              {inst.symbol}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
