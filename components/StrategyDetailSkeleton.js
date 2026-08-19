// Shimmering placeholder for a single strategy's detail page, shown
// instead of PageLoading while the strategy and its trades are still
// loading - mimics the eventual header, stat cards, At a glance card and
// trade table.
export default function StrategyDetailSkeleton() {
  return (
    <div className="page-container">
      <div className="strategy-header-row">
        <div className="skel skel-title" style={{ width: '260px', marginBottom: 0 }} />
        <div className="skel skel-circle" style={{ width: '26px', height: '26px' }} />
        <div className="skel skel-pill" style={{ width: '150px', marginLeft: 'auto' }} />
      </div>
      <div className="skel skel-subtitle" />
      <div className="header-pills-row">
        <div className="skel skel-pill" style={{ width: '120px' }} />
        <div className="skel skel-pill" style={{ width: '170px' }} />
      </div>

      <div className="section-heading">Performance</div>
      <div className="stats strategy-perf-stats">
        {Array.from({ length: 8 }).map((_, i) => (
          <div className="stat" key={i}>
            <div className="skel skel-line" style={{ width: '60%' }} />
            <div className="skel skel-value" />
          </div>
        ))}
      </div>

      <div className="section-heading">At a glance</div>
      <div className="panel">
        <div className="skel skel-line" style={{ width: '200px', height: '12px', marginBottom: '16px' }} />
        <div className="skel skel-line" />
        <div className="skel skel-line" style={{ width: '70%' }} />
      </div>

      <div className="section-heading">Trade log</div>
      <div className="panel">
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Day</th><th>Direction</th>
              <th>Result</th><th>P&amp;L</th><th></th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td><div className="skel skel-cell" /></td>
                <td><div className="skel skel-cell" /></td>
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
