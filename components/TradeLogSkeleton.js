// Shimmering placeholder table for the trade log, shown instead of
// PageLoading while trades are still loading. Column/header shape is
// configurable since the three pages that render this (per-instrument
// log, all-instruments log, and the Overview's Recent trades panel) don't
// all show the same columns or header button.
export default function TradeLogSkeleton({
  rows = 8,
  showDayColumn = true,
  showInstrumentColumn = false,
  showStrategyColumn = true,
  showHeaderButton = true,
}) {
  return (
    <div className="page-container">
      {showHeaderButton ? (
        <div className="strategy-header-row">
          <div className="skel skel-title" style={{ marginBottom: 0 }} />
          <div className="skel skel-pill" style={{ width: '150px', marginLeft: 'auto' }} />
        </div>
      ) : (
        <div className="skel skel-title" />
      )}
      <div className="skel skel-subtitle" />
      <div className="panel">
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              {showDayColumn && <th>Day</th>}
              {showInstrumentColumn && <th>Instrument</th>}
              {showStrategyColumn && <th>Strategy</th>}
              <th>Direction</th>
              <th>Result</th>
              <th>P&amp;L</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, i) => (
              <tr key={i}>
                <td><div className="skel skel-cell" /></td>
                {showDayColumn && <td><div className="skel skel-cell" /></td>}
                {showInstrumentColumn && <td><div className="skel skel-cell" style={{ width: '50%' }} /></td>}
                {showStrategyColumn && <td><div className="skel skel-cell" style={{ width: '70%' }} /></td>}
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
