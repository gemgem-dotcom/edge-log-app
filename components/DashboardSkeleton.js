// Shimmering placeholder for the per-instrument dashboard
// (app/[instrument]/dashboard), shown instead of PageLoading while the
// initial fetch is in flight. Only the header (title, subtitle, market
// status pill) is skeletoned - that part renders identically whether or
// not the instrument turns out to have any trades. The content below it
// doesn't: zero trades collapses to one small EmptyState panel, where any
// trades at all bring the full glance-cards/All-Time Performance/Monthly
// P&L stack, and there's no way to know which is coming until the fetch
// resolves. Guessing either shape would be wrong about as often as it's
// right, so that part falls back to the plain animated-bars loading
// treatment instead (see .content-loading).
export default function DashboardSkeleton() {
  return (
    <div className="page-container">
      <div className="strategy-header-row">
        <div className="skel skel-title" style={{ marginBottom: 0 }} />
        <div className="skel-clock" style={{ marginLeft: 'auto' }}>
          <div className="skel skel-line" style={{ width: '92px', marginBottom: '6px' }} />
          <div className="skel skel-line" style={{ width: '128px', marginBottom: 0 }} />
        </div>
      </div>
      <div className="skel skel-subtitle" />
      <div className="header-pills-row">
        {/* MarketStatusPill only - StreakBadge renders nothing without an
            active 2+ streak, which is the common case, so guessing a
            second pill here would be wrong more often than right. Third
            pill is "Log new trade", which always renders. */}
        <div className="skel skel-pill" style={{ width: '120px' }} />
        <div className="skel skel-pill" style={{ width: '140px', marginLeft: 'auto' }} />
      </div>

      <div className="content-loading">
        <div className="page-loading-bars">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} />
          ))}
        </div>
        <div className="page-loading-label">Loading</div>
      </div>
    </div>
  )
}
