'use client'

import { useState, useCallback } from 'react'
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
  const menuRef = useClickOutside(open, useCallback(() => setOpen(false), []))

  return (
    <div className="log-trade-menu-wrap" ref={menuRef}>
      <button type="button" className="new-trade-btn" onClick={() => setOpen((v) => !v)}>
        <Plus size={16} /> Log new trade
      </button>
      {open && (
        <div className="strategy-menu-dropdown log-trade-dropdown">
          {instruments.map((inst) => (
            <a key={inst.id} href={`/app/${inst.symbol}/log/new`} className="strategy-menu-item">
              {inst.symbol}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
