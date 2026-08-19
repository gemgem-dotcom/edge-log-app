// Shimmering placeholder for the strategies list, shown instead of
// PageLoading while the initial fetch is in flight.
export default function StrategiesSkeleton() {
  return (
    <div className="page-container">
      <div className="strategy-header-row">
        <div className="skel skel-title" style={{ marginBottom: 0 }} />
        <div className="skel skel-pill" style={{ width: '150px', marginLeft: 'auto' }} />
      </div>

      <div className="panel">
        <div className="skel skel-line" style={{ width: '140px', height: '12px', marginBottom: '16px' }} />
        <div className="skel skel-row" />
      </div>

      <div className="panel">
        <div className="skel skel-line" style={{ width: '200px', height: '12px', marginBottom: '16px' }} />
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="skel skel-row" key={i} />
        ))}
      </div>
    </div>
  )
}
