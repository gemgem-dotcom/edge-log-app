// Shimmering placeholder for the all-instruments Overview (app/app),
// shown instead of PageLoading while the initial fetch is in flight -
// mirrors this page's actual section order (header pills, brief/economic
// calendar row, market context row, All-Time Performance, Monthly P&L,
// Recent trades) so the loaded content doesn't jump into a noticeably
// different shape. Deliberately its own component rather than reusing
// DashboardSkeleton - the two pages share a family resemblance but their
// top section (this page's brief+calendar / market-context rows vs. the
// per-instrument page's At a glance cards) and bottom section (Recent
// trades vs. nothing) have diverged enough that one skeleton can't mimic
// both accurately.
export default function OverviewSkeleton() {
  return (
    <div className="page-container">
      <div className="page-header-row">
        <div className="skel skel-title" style={{ marginBottom: 0 }} />
        <div className="skel skel-pill" style={{ width: '150px' }} />
      </div>
      <div className="skel skel-subtitle" />
      <div className="header-pills-row">
        <div className="skel skel-pill" style={{ width: '120px' }} />
        <div className="skel skel-pill" style={{ width: '170px' }} />
      </div>

      <div className="dashboard-split brief-calendar-row">
        <div className="panel">
          <div className="skel skel-line" style={{ width: '110px', height: '12px', marginBottom: '16px' }} />
          <div className="skel skel-line" />
          <div className="skel skel-line" style={{ width: '70%' }} />
        </div>
        <div className="panel">
          <div className="skel skel-line" style={{ width: '140px', height: '12px', marginBottom: '16px' }} />
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="skel skel-row" key={i} />
          ))}
        </div>
      </div>

      <div className="market-context-row">
        <div className="panel">
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Instrument</th><th>Overnight gap</th><th>Range vs. typical</th><th>Volume vs. typical</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    <td><div className="skel skel-cell" style={{ width: '50%' }} /></td>
                    <td><div className="skel skel-cell" style={{ width: '60%' }} /></td>
                    <td><div className="skel skel-cell" style={{ width: '60%' }} /></td>
                    <td><div className="skel skel-cell" style={{ width: '60%' }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="skel skel-line" style={{ width: '110px', height: '12px', marginBottom: '16px' }} />
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="skel skel-row" key={i} />
          ))}
        </div>
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

      <div className="section-heading">Recent trades</div>
      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Date</th><th>Instrument</th><th>Strategy</th><th>Direction</th><th>Result</th><th>P&amp;L</th><th></th></tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td><div className="skel skel-cell" /></td>
                  <td><div className="skel skel-cell" style={{ width: '50%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '70%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '50%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '55%' }} /></td>
                  <td><div className="skel skel-cell" style={{ width: '60%' }} /></td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
