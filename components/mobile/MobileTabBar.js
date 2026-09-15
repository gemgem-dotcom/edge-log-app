'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid, List, Plus, Layers, User, X, ChevronRight } from 'lucide-react'
import { strategyColor } from '@/lib/strategyColor'
import { MOBILE_TABS, activeTabFor } from '@/lib/mobileTabs'

// Icons live here rather than in lib/mobileTabs.js so that module stays
// pure and testable - see its header.
const TAB_ICONS = {
  dashboard: LayoutGrid,
  log: List,
  new: Plus,
  strategies: Layers,
  account: User,
}

// The mobile app's primary navigation.
//
// The desktop has a persistent topbar with an instrument row and a tab
// strip - three rows of chrome before any content. That works with a
// mouse and 1440px; on a phone it ate a fifth of the screen and still
// left "Strategies" behind a dropdown.
//
// This is the standard phone answer instead: a fixed bottom bar, thumb
// reachable, with the one destructive-free primary action (log a trade)
// raised in the middle. Five is the most a bar this width holds without
// the labels truncating, and these are the five the app actually has.
//
// Renders only on mobile - the caller gates on useIsMobile - so there is
// no desktop markup to affect. Every class here is new and prefixed
// `m-`, so no existing rule reaches it either.
export default function MobileTabBar({ symbol, strategies = [], colorIndexById = {} }) {
  const pathname = usePathname()
  const active = activeTabFor(pathname)
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(() => {
    if (!sheetOpen) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [sheetOpen])

  return (
    <>
      {/* nav + aria-label so a screen reader can jump to it, and the same
          aria-current the desktop tab strip uses. */}
      <nav className="m-tabbar" aria-label="Main">
        {MOBILE_TABS.map(({ key, label, path, primary, sheet }) => {
          const Icon = TAB_ICONS[key]
          const isActive = active === key
          const inner = (
            <>
              <span className="m-tabbar-icon"><Icon size={primary ? 24 : 20} strokeWidth={2} /></span>
              <span className="m-tabbar-label">{label}</span>
            </>
          )
          const className = `m-tabbar-item${primary ? ' m-tabbar-item--primary' : ''}${isActive ? ' is-active' : ''}`

          if (sheet) {
            return (
              <button
                key={key}
                type="button"
                className={className}
                onClick={() => setSheetOpen((v) => !v)}
                aria-expanded={sheetOpen}
                aria-haspopup="dialog"
              >
                {inner}
              </button>
            )
          }
          return (
            <Link key={key} href={path(symbol)} className={className} aria-current={isActive ? 'page' : undefined}>
              {inner}
            </Link>
          )
        })}
      </nav>

      {sheetOpen ? (
        <div className="m-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div
            className="m-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Strategies"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-sheet-grab" aria-hidden="true" />
            <div className="m-sheet-head">
              <h2>Strategies</h2>
              <button type="button" className="m-sheet-close" onClick={() => setSheetOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="m-sheet-body">
              {strategies.length ? (
                <ul className="m-strategy-list">
                  {strategies.map((s) => (
                    <li key={s.id}>
                      {/* Closed here, on the tap, rather than in an
                          effect watching the pathname. Same result -
                          tapping a strategy must not leave the sheet
                          sitting over the page it just opened - but it
                          is the navigation itself that should close it,
                          and reacting to the route afterwards means a
                          setState inside an effect for something the
                          click handler already knows. */}
                      <Link
                        href={`/app/${symbol}/strategies/${s.id}`}
                        className="m-strategy-row"
                        onClick={() => setSheetOpen(false)}
                      >
                        {/* Same colour the desktop sidebar and the
                            dashboard's strategy table use, keyed the same
                            way - see strategyColor's own comment on why
                            the index must come from creation order. */}
                        <span className="m-strategy-dot" style={{ background: strategyColor(colorIndexById[s.id]) }} />
                        <span className="m-strategy-name">{s.name}</span>
                        <ChevronRight size={16} className="m-strategy-chevron" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-empty">No strategies yet. Add one from the Overview page.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
