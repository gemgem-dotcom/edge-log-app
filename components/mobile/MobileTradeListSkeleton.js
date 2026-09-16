// Placeholder for MobileTradeList, in that list's own shape.
//
// The skeletons all rendered the DESKTOP table on a phone: eight columns,
// a 640px min-width, inside a horizontal scroller. So the loading state
// promised a layout the loaded state never delivered - the page visibly
// changed shape the moment data arrived, which is the one thing a
// skeleton exists to prevent.
//
// Mirrors the real list exactly: toolbar (filter left, count right), the
// three-label column header, then rows on the same
// `auto minmax(0,1fr) auto 14px` grid with two lines per column.
export default function MobileTradeListSkeleton({ rows = 6, showToolbar = true }) {
  return (
    <>
      {showToolbar ? (
        <div className="m-list-toolbar">
          <div className="skel skel-pill" style={{ width: '88px', height: '36px', borderRadius: '8px' }} />
          <div className="skel skel-cell" style={{ width: '64px' }} />
        </div>
      ) : null}
      <div className="m-rows-head" aria-hidden="true">
        <span>Date</span><span>Strategy</span><span>Result</span><span />
      </div>
      <ul className="m-rows">
        {Array.from({ length: rows }).map((_, i) => (
          <li className="m-row" key={i}>
            <div className="m-row-head" aria-hidden="true">
              <span className="m-col">
                <span className="skel skel-cell" style={{ width: '78px' }} />
                <span className="skel skel-cell" style={{ width: '54px', height: '10px' }} />
              </span>
              <span className="m-col">
                <span className="skel skel-cell" style={{ width: '80%' }} />
                <span className="skel skel-cell" style={{ width: '44px', height: '10px' }} />
              </span>
              <span className="m-col m-col-figs">
                <span className="skel skel-pill" style={{ width: '58px', height: '20px' }} />
                <span className="skel skel-cell" style={{ width: '62px', height: '10px' }} />
              </span>
              <span />
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
