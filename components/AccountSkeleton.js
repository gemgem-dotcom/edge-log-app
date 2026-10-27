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
      {/* The real topbar, placeholdered. The page used to render no
          topbar at all while loading, so the body started at y=0 and then
          dropped by the spacer's height the moment data arrived - the
          same content jump the mobile topbar was added to this page to
          fix in the first place.
          Not given the ref/state classes the real one carries: there is
          nothing to scroll yet, so it only ever needs its docked look. */}
      <header className="shell-topbar m-account-topbar topbar-anchored" aria-hidden="true">
        <span className="shell-logo">Edge<span>Log</span></span>
        <div className="shell-topbar-right">
          {/* 44px, matching the scope control it stands in for. That is the
              iOS minimum tap target rather than a measured sum, so unlike
              the spacer this replaced it does not drift: when the control
              was 32px here and 44px on the loaded page, the bar came out
              12px short and stepped the screen. */}
          <span className="skel skel-pill" style={{ width: '62px', height: '44px' }} />
        </div>
      </header>
      {/* No spacer, and no hardcoded height. topbar-anchored drops the
          fixed positioning (the class the first-run tutorial already uses
          for exactly this), so the bar sits in flow and occupies its own
          real height plus margins - which is precisely what the spacer
          reserves on the loaded page.
          It was a literal 76px before and that number was wrong twice: the
          bar is 52px until any control inside it grows, and raising the
          scope button to the 44pt tap-target minimum took it to 66px,
          stepping the whole screen 14px. A measurement that can go stale
          beats nothing, but a layout that cannot be wrong beats both. */}

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
      {/* The real one, not a placeholder. Account sits outside the
          instrument layout that renders the tab bar everywhere else, so
          the page renders its own - and while loading there was none,
          meaning it popped in at the end and there was no way off this
          screen until the fetch resolved. symbol={null} and the default
          empty instruments are exactly what the loaded page passes it. */}
      <MobileTabBar symbol={null} />
    </div>
  )
}
