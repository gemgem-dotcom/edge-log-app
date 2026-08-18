// Shimmering placeholder for the all-instruments Overview
// (OverviewDashboard.js), shown instead of PageLoading while the initial
// fetch is in flight. Mirrors that page's actual section order: header
// pills, the Today's brief/Economic calendar row, the four market-context
// cards, All-Time Performance stats, Equity curve + P&L-by-instrument,
// Monthly P&L, and Recent trades - a generic shape (the old shared
// DashboardSkeleton) drifted out of sync with this page's real layout
// once those sections were added, so this one is specific to it instead.
export default function OverviewDashboardSkeleton() {
  return (
    <div className="page-container">
      <div className="skel skel-title" />
      <div className="skel skel-subtitle" />
      <div className="header-pills-row">
        <div className="skel skel-pill" style={{ width: '110px' }} />
        <div className="skel skel-pill" style={{ width: '170px' }} />
      </div>

      <div className="dashboard-split brief-calendar-row">
        <div>
          <div className="panel">
            <div className="skel skel-line" style={{ width: '35%' }} />
            <div className="skel skel-line" style={{ width: '90%' }} />
            <div className="skel skel-line" style={{ width: '55%' }} />
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="skel skel-line" style={{ width: '30%' }} />
            <div className="skel skel-row" style={{ width: '260px', height: '32px', marginTop: '12px' }} />
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="skel skel-row" key={i} />
            ))}
          </div>
        </div>
      </div>

      <div className="market-context-row">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="panel" key={i}>
            <div className="skel skel-line" style={{ width: '65%' }} />
            <div className="skel skel-row" />
            <div className="skel skel-row" />
          </div>
        ))}
      </div>

      <div className="section-heading">All-Time Performance</div>
      <div className="stats stats-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="stat" key={i}>
            <div className="skel skel-line" style={{ width: '60%' }} />
            <div className="skel skel-value" />
          </div>
        ))}
        <div className="stat stat-gauge">
          <div className="skel skel-line" style={{ width: '55%' }} />
          <div className="skel skel-circle" style={{ width: '110px', height: '110px', margin: '10px auto 0' }} />
        </div>
      </div>

      <div className="dashboard-split">
        <div>
          <div className="panel">
            <div className="skel skel-line" style={{ width: '30%' }} />
            <div className="skel skel-row" style={{ width: '200px', height: '30px', marginTop: '4px' }} />
            <div className="skel" style={{ width: '100%', height: '180px', marginTop: '16px' }} />
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="skel skel-line" style={{ width: '55%' }} />
            <div className="skel skel-circle" style={{ width: '200px', height: '200px', margin: '20px auto' }} />
          </div>
        </div>
      </div>

      <div className="section-heading">Monthly P&L</div>
      <div className="panel">
        <div className="skel skel-line" style={{ width: '160px', height: '32px', marginBottom: '18px' }} />
        <div className="stats stats-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="stat" key={i}>
              <div className="skel skel-line" style={{ width: '60%' }} />
              <div className="skel skel-value" />
            </div>
          ))}
          <div className="stat stat-gauge">
            <div className="skel skel-line" style={{ width: '55%' }} />
            <div className="skel skel-circle" style={{ width: '110px', height: '110px', margin: '10px auto 0' }} />
          </div>
        </div>
        <div className="skel-calendar-grid">
          {Array.from({ length: 35 }).map((_, i) => (
            <div className="skel skel-calendar-cell" key={i} />
          ))}
        </div>
      </div>

      <div className="section-heading">Recent trades</div>
      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Time</th><th>Instrument</th><th>Strategy</th><th>R</th><th>P&amp;L</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  <td><div className="skel skel-cell" /></td>
                  <td><div className="skel skel-cell" style={{ width: '50%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '70%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '40%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '55%' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
