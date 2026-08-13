import { MOCK_ECON_EVENTS } from '@/lib/marketContextMock'

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}

// Mock data only (lib/marketContextMock.js) - not sourced from any live
// feed. The BLS/FRED/FOMC scrapers this card used to run on were pulled out
// in favor of a future paid provider; MOCK_ECON_EVENTS's shape (time,
// event, impact, forecast, previous) is what that provider's data should
// slot into so this component doesn't need to change.
//
// Reused as-is on the per-instrument Overview page. A future version
// should filter events down to whatever's relevant to that instrument's
// underlying currency/market instead of always showing the same US-wide
// list - no such filtering exists yet.
export default function EconomicCalendarCard() {
  return (
    <>
      <div className="econ-calendar-header-row">
        <div className="stat-label dashboard-card-title" style={{ marginBottom: 0 }}>Economic calendar</div>
        <div className="econ-calendar-today">Today · {todayLabel()}</div>
      </div>
      <div className="econ-calendar-mock-list">
        {MOCK_ECON_EVENTS.map((e, i) => (
          <div className="econ-calendar-mock-row" key={i}>
            <span className={`econ-impact-dot econ-impact-${e.impact}`} />
            <span className="econ-calendar-mock-time">{e.time}</span>
            <span className="econ-calendar-mock-event">{e.event}</span>
            <span className="econ-calendar-mock-figures">
              {e.forecast ? <>fcst {e.forecast} &nbsp;&nbsp; prev {e.previous}</> : '–'}
            </span>
          </div>
        ))}
      </div>
      {/* Mock only - a real version would check whether the trader's own
          strategies (tags, typical session times) line up with today's
          high-impact events instead of this hardcoded line. */}
      <div className="econ-calendar-mock-footer">
        2 of your strategies trade around high-impact events today — Powell 10am, Break and Retest
      </div>
    </>
  )
}
