// Shimmering placeholder for a single instrument's dashboard
// (app/app/[instrument]/dashboard/page.js), shown instead of PageLoading
// while the initial fetch is in flight. Mirrors that page's actual section
// order: header (with the Log new trade button), header pills, Overview
// (stats + P&L-by-strategy donut), Economic calendar, At a glance (Key
// levels/Today's brief/the four market-context cards), Strategy
// performance, and Monthly P&L - a generic shape (the old shared
// DashboardSkeleton) drifted out of sync with this page's real layout
// once those sections were added, so this one is specific to it instead.
export default function InstrumentDashboardSkeleton() {
  return (
    <div className="page-container">
      <div className="page-header-row">
        <div className="skel skel-title" style={{ marginBottom: 0 }} />
        <div className="skel" style={{ width: '150px', height: '36px', borderRadius: '100px' }} />
      </div>
      <div className="skel skel-subtitle" />
      <div className="header-pills-row">
        <div className="skel skel-pill" style={{ width: '110px' }} />
        <div className="skel skel-pill" style={{ width: '190px' }} />
      </div>

      <div className="section-heading">Overview</div>
      <div className="dashboard-split">
        <div>
          <div className="stats stats-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="stat" key={i}>
                <div className="skel skel-line" style={{ width: '60%' }} />
                <div className="skel skel-value" />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="skel skel-line" style={{ width: '60%' }} />
            <div className="skel skel-circle" style={{ width: '160px', height: '160px', margin: '20px auto' }} />
          </div>
        </div>
      </div>

      <div className="section-heading">Economic calendar</div>
      <div className="panel">
        <div className="skel skel-line" style={{ width: '30%' }} />
        <div className="skel skel-row" style={{ width: '260px', height: '32px', marginTop: '12px' }} />
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="skel skel-row" key={i} />
        ))}
      </div>

      <div className="section-heading">At a glance</div>
      <div className="instrument-glance-row">
        <div className="panel">
          <div className="skel skel-line" style={{ width: '45%' }} />
          <div className="skel skel-row" />
          <div className="skel skel-row" />
          <div className="skel skel-row" />
        </div>
        <div className="panel">
          <div className="skel skel-line" style={{ width: '35%' }} />
          <div className="skel skel-line" style={{ width: '90%' }} />
          <div className="skel skel-line" style={{ width: '55%' }} />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div className="panel" key={i}>
            <div className="skel skel-line" style={{ width: '65%' }} />
            <div className="skel skel-value" />
          </div>
        ))}
      </div>

      <div className="section-heading">Strategy performance</div>
      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Strategy</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>Profit factor</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td><div className="skel skel-cell" style={{ width: '70%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '40%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '50%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '55%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '45%' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section-heading">Monthly P&L</div>
      <div className="panel">
        <div className="skel skel-line" style={{ width: '160px', height: '32px', marginBottom: '18px' }} />
        <div className="stats">
          {Array.from({ length: 4 }).map((_, i) => (
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
