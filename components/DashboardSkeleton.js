// Shimmering placeholder for the dashboard, shown instead of PageLoading
// while the initial fetch is in flight - roughly mimics the eventual stat
// cards, strategy table and calendar instead of a centered spinner.
export default function DashboardSkeleton() {
  return (
    <div className="page-container">
      <div className="skel skel-title" />
      <div className="skel skel-subtitle" />

      <div className="section-heading">Overview</div>
      <div className="stats stats-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="stat" key={i}>
            <div className="skel skel-line" style={{ width: '60%' }} />
            <div className="skel skel-value" />
          </div>
        ))}
      </div>

      <div className="section-heading">Strategy performance</div>
      <div className="panel">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="skel skel-row" key={i} />
        ))}
      </div>

      <div className="section-heading">Monthly P&L</div>
      <div className="panel">
        <div className="skel skel-line" style={{ width: '160px', height: '32px', marginBottom: '18px' }} />
        <div className="stats stats-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div className="stat" key={i}>
              <div className="skel skel-line" style={{ width: '60%' }} />
              <div className="skel skel-value" />
            </div>
          ))}
        </div>
        <div className="skel-calendar-grid">
          {Array.from({ length: 35 }).map((_, i) => (
            <div className="skel skel-calendar-cell" key={i} />
          ))}
        </div>
      </div>
    </div>
  )
}
