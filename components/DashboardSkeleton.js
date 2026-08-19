// Shimmering placeholder for the per-instrument dashboard
// (app/[instrument]/dashboard), shown instead of PageLoading while the
// initial fetch is in flight - mirrors this page's actual section order
// (header pills, All-Time Performance, At a glance, Monthly P&L) so the
// loaded content doesn't jump into a noticeably different shape.
export default function DashboardSkeleton() {
  return (
    <div className="page-container">
      <div className="strategy-header-row">
        <div className="skel skel-title" style={{ marginBottom: 0 }} />
        <div className="skel skel-circle" style={{ width: '26px', height: '26px' }} />
        <div className="skel skel-pill" style={{ width: '150px', marginLeft: 'auto' }} />
      </div>
      <div className="skel skel-subtitle" />
      <div className="header-pills-row">
        <div className="skel skel-pill" style={{ width: '120px' }} />
        <div className="skel skel-pill" style={{ width: '170px' }} />
      </div>

      <div className="section-heading">All-Time Performance</div>
      <div className="panel">
        <div className="skel skel-line" style={{ width: '160px', height: '32px', marginBottom: '18px' }} />
        <div className="stats stats-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div className={`stat${i === 2 ? ' stat-gauge' : ''}`} key={i}>
              <div className="skel skel-line" style={{ width: '60%' }} />
              {i === 2 ? (
                <div className="skel skel-circle" style={{ width: '100px', height: '52px', margin: '4px auto 0' }} />
              ) : (
                <div className="skel skel-value" />
              )}
            </div>
          ))}
        </div>
        <div className="performance-card-subgrid">
          <div>
            <div className="skel skel-line" style={{ width: '160px', height: '12px', marginBottom: '16px' }} />
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="skel skel-line" key={i} style={{ marginBottom: '12px' }} />
            ))}
          </div>
          <div>
            <div className="skel skel-line" style={{ width: '110px', height: '12px', marginBottom: '16px' }} />
            <div className="skel" style={{ height: '130px', borderRadius: '10px' }} />
          </div>
        </div>
      </div>

      <div className="section-heading">At a glance</div>
      <div className="instrument-glance-row">
        {Array.from({ length: 3 }).map((_, i) => (
          <div className="panel" key={i}>
            <div className="skel skel-line" style={{ width: '120px', height: '12px', marginBottom: '16px' }} />
            {Array.from({ length: 3 }).map((_, j) => (
              <div className="skel skel-row" key={j} />
            ))}
          </div>
        ))}
      </div>
      <div className="market-context-row">
        <div className="panel">
          <div className="skel skel-line" style={{ width: '160px', height: '12px', marginBottom: '16px' }} />
          {Array.from({ length: 2 }).map((_, i) => (
            <div className="skel skel-row" key={i} />
          ))}
        </div>
        <div className="panel">
          <div className="skel skel-line" style={{ width: '110px', height: '12px', marginBottom: '16px' }} />
          <div className="skel skel-value" />
        </div>
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
