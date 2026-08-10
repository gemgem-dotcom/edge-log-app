// Shimmering placeholder table for the trade log, shown instead of
// PageLoading while trades are still loading.
export default function TradeLogSkeleton({ rows = 8 }) {
  return (
    <div className="page-container">
      <div className="skel skel-title" />
      <div className="skel skel-subtitle" />
      <div className="panel">
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Day</th><th>Strategy</th><th>Direction</th>
              <th>Result</th><th>P&amp;L</th><th></th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, i) => (
              <tr key={i}>
                <td><div className="skel skel-cell" /></td>
                <td><div className="skel skel-cell" /></td>
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
