// Shimmering placeholder for the all-instruments Overview (app/app),
// shown instead of PageLoading while the initial fetch is in flight.
// Only the header (greeting, subtitle, market status pill) is
// skeletoned - that part renders identically regardless of whether the
// account turns out to have any trades. The content below it doesn't:
// zero trades collapses to one small EmptyState panel, where any trades
// at all bring the full brief/calendar row, market context row,
// All-Time Performance, Monthly P&L and Recent trades stack, and
// there's no way to know which is coming until the fetch resolves.
// Guessing either shape would be wrong about as often as it's right, so
// that part falls back to the plain animated-bars loading treatment
// instead (see .content-loading) - same reasoning as DashboardSkeleton,
// which this is deliberately its own component rather than sharing with,
// since the two pages' header rows and populated-content shapes differ.
export default function OverviewSkeleton() {
  return (
    <div className="page-container">
      <div className="page-header-row">
        <div className="skel skel-title" style={{ marginBottom: 0 }} />
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
