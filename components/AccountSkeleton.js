'use client'

import { useIsMobile } from '@/lib/useIsMobile'
import PageLoading from '@/components/PageLoading'
import MobileTabBar from '@/components/mobile/MobileTabBar'
import { ACCOUNT_SECTIONS } from '@/lib/accountSections'

// Placeholder for the account screen's mobile index.
//
// MOBILE ONLY, and deliberately. The desktop account page stacks all
// seven sections on one long page, each with its own internal shape
// (a form, a theme switcher, a sign-in table, a danger zone) - a faithful
// skeleton of that is most of a second copy of the page, and it is behind
// a single fetch that resolves in one round trip. Desktop keeps the
// animated bars; the phone is where the index shape is simple enough to
// promise honestly.
//
// Row count comes from ACCOUNT_SECTIONS rather than a guess, because the
// index's rows are static data - the fetch supplies what is INSIDE each
// section, never which sections exist. So this is the rare skeleton that
// cannot be wrong about how many rows arrive.
//
// Does not skeleton the drill-down (?section=<key>). Those screens are
// one section each, with seven different shapes, and arriving at one
// directly is far rarer than arriving at the index - so they keep the
// bars rather than get a shape that is right one time in seven.
export default function AccountSkeleton() {
  const isMobile = useIsMobile()
  if (!isMobile) return <PageLoading />

  return (
    <div>
      {/* No topbar placeholder here any more, and no spacer either.
          This used to render a whole stand-in bar, because the page had
          none while loading and the body jumped down by the spacer's
          height the moment data arrived. The real bar is mounted in
          app/app/layout.js now and is already on screen before this
          renders, so there is nothing left to stand in for - and with it
          went the one number in this file that kept going stale (the
          spacer height, wrong twice).
          It also took with it a real inconsistency: the stand-in logo had
          no icon, so arriving at Account showed a bare "EdgeLog" that
          grew a mark the moment the page loaded. */}
      <div className="account-wrap">
        <div className="skel skel-title" style={{ marginTop: '4px' }} />
        <div className="skel skel-subtitle" />
        <div className="panel m-account-index">
          {ACCOUNT_SECTIONS.map((s) => (
            <span key={s.key} className="m-account-row" aria-hidden="true">
              {/* Heights pinned to the loaded row's own line boxes (a 14px
                  label over a 12px hint), so the seven rows add up to the
                  same height before and after - see StrategyListSkeleton
                  for what happens when they are left to the bars. */}
              <span className="m-account-row-body">
                <span className="m-account-row-label" style={{ height: '17px', display: 'flex', alignItems: 'center' }}>
                  <span className="skel skel-cell" style={{ width: `${s.label.length * 7 + 16}px` }} />
                </span>
                <span className="m-account-row-hint" style={{ height: '15px', display: 'flex', alignItems: 'center' }}>
                  <span className="skel skel-cell" style={{ width: `${Math.min(s.hint.length * 6 + 10, 210)}px`, height: '10px' }} />
                </span>
              </span>
              <span className="skel skel-cell" style={{ width: '16px', height: '16px', flexShrink: 0 }} />
            </span>
          ))}
        </div>
        {/* Log out and the signed-in-as line both sit below the index on
            mobile, so leaving them out would shorten the page and scroll
            it the moment they appeared. */}
        <span className="skel skel-pill" style={{ display: 'block', width: '100%', height: '40px', marginTop: '14px' }} />
        <span className="skel skel-cell" style={{ display: 'block', width: '180px', height: '10px', margin: '14px auto 0' }} />
      </div>
      {/* The tab bar came from here too, for the same reason: this screen
          sat outside the layout that rendered it everywhere else, so
          while loading there was none and no way off the screen until the
          fetch resolved. It is mounted above this now and never unmounts. */}
    </div>
  )
}
