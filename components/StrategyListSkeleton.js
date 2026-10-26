// Placeholder for StrategyList, in that list's own shape.
//
// Both strategies index pages (/app/[instrument]/strategies and
// /app/strategies) showed the full-screen PageLoading bars, so on a phone
// the whole screen was blank chrome and then the list appeared - the title
// and subtitle arrived at the same moment as the data, even though neither
// depends on it.
//
// Mirrors the real list exactly: the same .panel > ul.m-strategy-index >
// li > .m-strategy-index-row, each row a dot, a two-line body (name over
// stats) and a chevron. Those classes are only styled below 768px, which
// is also true of the real StrategyList - it renders this same markup at
// every width - so the skeleton is wrong in exactly the places the loaded
// page is, and never in a place it isn't.
//
// `showInstrument` adds the per-row instrument tag the all-instruments
// page passes to StrategyList, so the name line reserves the same width
// there as it will once loaded.
export default function StrategyListSkeleton({ rows = 5, showInstrument = false }) {
  return (
    <div className="page-container">
      {/* marginTop mirrors the h1 rule; see .skel-title in globals.css. */}
      <div className="skel skel-title" style={{ marginTop: '4px' }} />
      <div className="skel skel-subtitle" />
      {/* No EmptyState shape here on purpose. Zero strategies renders a
          single EmptyState panel instead of a list, and there is no way
          to know which is coming until the fetch resolves - but unlike
          the dashboard's equivalent coin-flip, anyone opening Strategies
          from the tab bar overwhelmingly has some, and a five-row list is
          the shape that is right nearly always. */}
      <div className="panel">
        <ul className="m-strategy-index">
          {Array.from({ length: rows }).map((_, i) => (
            <li key={i}>
              <span className="m-strategy-index-row" aria-hidden="true">
                {/* .strategy-dot carries its colour inline from
                    strategyColor, so without a background here it would
                    render as an invisible gap rather than a dot. */}
                <span className="skel skel-circle" style={{ width: '9px', height: '9px', flexShrink: 0 }} />
                {/* The two line heights are pinned to what the loaded row
                    actually measures (a 14px name line and a 10.5px stats
                    line), so the row is the same 63px tall either way.
                    Letting the bars size these instead made the skeleton
                    row 41px - five rows, 110px of scroll that appeared the
                    moment the data landed. */}
                <span className="m-strategy-index-body">
                  <span className="m-strategy-index-name" style={{ height: '17px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className="skel skel-cell" style={{ width: showInstrument ? '58%' : '70%' }} />
                    {showInstrument ? (
                      <span className="skel skel-pill" style={{ width: '38px', height: '14px', flexShrink: 0 }} />
                    ) : null}
                  </span>
                  <span className="m-strategy-index-stats" style={{ height: '16px', alignItems: 'center' }}>
                    <span className="skel skel-cell" style={{ width: '52px', height: '10px' }} />
                    <span className="skel skel-cell" style={{ width: '46px', height: '10px' }} />
                  </span>
                </span>
                <span className="skel skel-cell" style={{ width: '16px', height: '16px', flexShrink: 0 }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
