// The US economic outlook, in a macOS window inside Today's brief.
//
// IT IS A TITLED PANEL, NOT A COSTUME. Two passes got this wrong in
// opposite directions. The first styled the inside like a shell session -
// `$ outlook --release "CPI m/m"` above every block, every line monospace,
// a hardcoded near-black ground - which read as a code sample pasted into
// a trading journal, and whose fake prompts implied a command you could
// type against a tool that does not exist. The second kept macOS traffic
// lights on the bar: three dots that cannot close, minimise or zoom
// anything, which is decoration pretending to be controls.
//
// What is left is the part that was doing work: a titled strip over a
// recessed well, in EdgeLog's own vocabulary - body copy at the same
// 13px/1.55 as .brief-card-text, .stat-label's uppercase micro-labels over
// the figures, JetBrains Mono on numbers ONLY (which is where the rest of
// the app uses it), and theme tokens throughout, so it follows the light
// theme instead of staying a black box in it.
//
// EVERY LINE HERE IS DERIVED FROM A STORED ROW. Forecast, previous and
// actual are columns on economic_events; the record counts actual against
// forecast on past rows of the same release; the read is generated from
// one template with the direction flipped. Nothing is fetched from a news
// source and nothing is a prediction - see lib/econBriefing.js's header.
export default function EconTerminal({ brief }) {
  if (!brief || brief.events.length === 0) return null

  const title = brief.highCount > 0
    ? `${brief.highCount} high-impact US release${brief.highCount === 1 ? '' : 's'} today`
    : 'US calendar today'

  return (
    <div className="econ-term">
      <div className="econ-term-bar">
        <span className="econ-term-title">{title}</span>
      </div>

      <div className="econ-term-body">
        {/* The releases are their own grid so auto-fit can collapse the
            tracks it does not need - see .econ-term-grid. The source line
            below is a SIBLING of it, not a cell spanning it. */}
        <div className="econ-term-grid">
        {brief.events.map(({ event, timestamp, meaning, framing, bias }) => (
          <div className="econ-term-release" key={event.event_key}>
            <div className="econ-term-head">
              <span className={`econ-term-dot econ-term-dot-${event.impact}`} aria-hidden="true" />
              <span className="econ-term-name">{event.title}</span>
              <span className="econ-term-clock">{clockFor(timestamp)}</span>
            </div>

            <p className="econ-term-copy">
              {sentence(meaning.what)} It moves {meaning.affects}.
            </p>

            {/* The three figures as a small stat row rather than a line of
                `fcast 0.3% prev 0.2%` - same uppercase-label-over-mono-value
                shape the Session stats card beside this one already uses. */}
            {event.forecast || event.previous || event.actual ? (
              <div className="econ-term-figs">
                <Fig label="Forecast" value={event.forecast} />
                <Fig label="Previous" value={event.previous} />
                <Fig label="Actual" value={event.actual} highlight />
              </div>
            ) : null}

            {/* The real record of this release against its own forecast.
                Absent until there are three past prints to read. */}
            {bias ? (
              <p className="econ-term-note">
                <span className="econ-term-note-label">Record</span>
                {`Last ${bias.prints} prints: ${bias.verdict}.`}
              </p>
            ) : null}

            {framing ? (
              <p className="econ-term-note">
                <span className="econ-term-note-label">Read</span>
                {framing}
              </p>
            ) : null}
          </div>
        ))}
        </div>

        {/* Says where the numbers come from, so nothing in the window reads
            as a market call. */}
        <p className="econ-term-source">Figures as published by Forex Factory.</p>
      </div>
    </div>
  )
}

function Fig({ label, value, highlight = false }) {
  return (
    <div className="econ-term-fig">
      <span className="econ-term-fig-label">{label}</span>
      <span className={`econ-term-fig-value${highlight && value ? ' is-actual' : ''}`}>
        {value || '—'}
      </span>
    </div>
  )
}

// meaningFor's `what` finishes "<Title> is ...", so it arrives lowercase.
// Opening a paragraph with it needs the capital back.
function sentence(text) {
  const s = String(text || '')
  if (!s) return ''
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`
}

// An all-day row arrives at local midnight and has no instant to quote.
function clockFor(timestamp) {
  const d = new Date(timestamp)
  if (d.getHours() === 0 && d.getMinutes() === 0) return 'All day'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
