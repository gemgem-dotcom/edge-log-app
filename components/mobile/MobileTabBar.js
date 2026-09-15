'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid, List, Plus, Layers, User, X } from 'lucide-react'
import { INSTRUMENT_CATALOG } from '@/lib/instrumentCatalog'
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

function displayNameFor(symbol) {
  return INSTRUMENT_CATALOG.find((i) => i.symbol === symbol)?.display_name || ''
}

// The mobile app's primary navigation.
//
// The desktop has a persistent topbar with an instrument row and a tab
// strip - three rows of chrome before any content. That works with a
// mouse and 1440px; on a phone it ate a fifth of the screen and still
// left "Strategies" behind a dropdown.
//
// This is the standard phone answer instead: a fixed bottom bar, thumb
// reachable. Five is the most a bar this width holds without the labels
// truncating, and these are the five the app actually has.
//
// Strategies used to open a bottom sheet from here because there was no
// strategies index route to point at; there is one now
// (app/app/[instrument]/strategies/page.js), so it is an ordinary link
// like the rest.
//
// Renders only on mobile - the caller gates on useIsMobile - so there is
// no desktop markup to affect. Every class here is prefixed `m-`, so no
// existing rule reaches it either.
export default function MobileTabBar({ symbol, instruments = [] }) {
  const pathname = usePathname()
  const active = activeTabFor(pathname)
  // Only ever open on the instrument-less screens - see the Log tab below.
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!pickerOpen) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [pickerOpen])

  return (
    <>
      {/* nav + aria-label so a screen reader can jump to it, and the same
          aria-current the desktop tab strip uses. */}
      <nav className="m-tabbar" aria-label="Main">
        {MOBILE_TABS.map(({ key, label, path }) => {
          const Icon = TAB_ICONS[key]
          const isActive = active === key
          // Uniform: no tab is visually privileged. The Log tab used to
          // be a raised accent circle, which is the most template-looking
          // element in mobile design and made one of five equals shout.
          const inner = (
            <>
              <span className="m-tabbar-icon"><Icon size={19} strokeWidth={1.75} /></span>
              <span className="m-tabbar-label">{label}</span>
            </>
          )
          const className = `m-tabbar-item${isActive ? ' is-active' : ''}`

          // "Log a trade" needs an instrument, and three screens have
          // none in view (/app, /app/log, /app/account). The tab's own
          // path degrades to /app there, which on /app itself means the
          // Log tab does nothing at all - and /app is exactly where the
          // desktop's LogTradeMenu (an instrument picker) lives, the
          // control this bar replaces on mobile. So the tab picks the
          // instrument itself rather than dumping the trader on a page
          // and hoping they find another way.
          if (key === 'new' && !symbol) {
            return (
              <button
                key={key}
                type="button"
                className={className}
                onClick={() => setPickerOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
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

      {pickerOpen ? (
        <div className="m-sheet-backdrop" onClick={() => setPickerOpen(false)}>
          <div
            className="m-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Log a trade"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-sheet-grab" aria-hidden="true" />
            <div className="m-sheet-head">
              <h2>Log a trade</h2>
              <button type="button" className="m-sheet-close" onClick={() => setPickerOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="m-sheet-body">
              {instruments.length ? (
                <ul className="m-scope-list">
                  {instruments.map((inst) => (
                    <li key={inst.id || inst.symbol}>
                      <Link
                        href={`/app/${inst.symbol}/log/new`}
                        className="m-scope-row"
                        onClick={() => setPickerOpen(false)}
                      >
                        <span className="m-scope-row-sym">{inst.symbol}</span>
                        <span className="m-scope-row-name">{displayNameFor(inst.symbol)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-empty">
                  <Link href="/app" className="m-strategy-link" onClick={() => setPickerOpen(false)}>
                    Add an instrument first
                  </Link>
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
