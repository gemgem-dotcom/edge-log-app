'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { MoreVertical } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { useClickOutside } from '@/lib/useClickOutside'
import { useConfirm } from '@/lib/useConfirm'
import { toast } from '@/lib/toast'

// Kebab menu next to the page title on each per-instrument page (Overview,
// Trade Log, Strategies) - same shape as the strategy detail page's own
// menu. "Remove instrument" is a soft hide (instruments.archived), not a
// delete: every instruments query across the app filters it out, so the
// instrument and everything under it (trades, strategies, stats) vanishes
// from the whole app without losing any data. Re-adding the same symbol
// from "+ Add instrument" (InstrumentNav.js, via lib/instruments.js) flips
// it back rather than starting over.
export default function InstrumentMenu({ instrumentId, symbol }) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useClickOutside(menuOpen, useCallback(() => setMenuOpen(false), []))
  const { confirm, modal } = useConfirm()

  async function handleRemove() {
    setMenuOpen(false)
    const sure = await confirm({
      title: 'Remove instrument',
      message: `This hides ${symbol} and everything under it — trades, strategies, stats — everywhere in EdgeLog, as if it were deleted. Nothing is actually deleted: add ${symbol} back later from "+ Add instrument" and it all reappears exactly as it was.`,
      confirmLabel: 'Remove instrument',
      danger: true,
    })
    if (!sure) return

    const { error } = await supabase.from('instruments').update({ archived: true }).eq('id', instrumentId)
    if (error) {
      toast.error(`Couldn't remove ${symbol} — ${error.message}`)
      return
    }
    toast.success(`${symbol} removed.`)
    router.push('/app')
  }

  return (
    <div className="strategy-menu-wrap" ref={menuRef}>
      <div className="strategy-menu-btn" onClick={() => setMenuOpen(!menuOpen)}>
        <MoreVertical size={17} />
      </div>
      {menuOpen && (
        <div className="strategy-menu-dropdown">
          <div className="strategy-menu-item strategy-menu-item-danger" onClick={handleRemove}>
            Remove instrument
          </div>
        </div>
      )}
      {modal}
    </div>
  )
}
