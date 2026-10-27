// The US economic outlook, as a macOS terminal window inside Today's brief.
//
// WHY A TERMINAL. The card's own sentence says the human thing - "you're on
// a streak, and CPI m/m lands at 08:30". Everything underneath it is
// reference data a trader scans rather than reads: figures that must line
// up in columns, a record of past prints, two readings of the same
// surprise. A terminal is the honest shape for that, and the monospace
// column alignment is doing real work rather than being decoration.
//
// The chrome is deliberately macOS: traffic lights left, centred title.
// It is inert - the three dots are not buttons and carry aria-hidden, since
// a control that looks like it closes something and does nothing is worse
// than no control.
//
// EVERY LINE HERE IS DERIVED FROM A STORED ROW. The forecast, previous and
// actual are columns on economic_events; the record counts actual against
// forecast on past rows of the same release; the two-sided read is
// generated from one template with the direction flipped. Nothing is
// fetched from a news source and nothing is a prediction - see the header
// of lib/econBriefing.js, and the PR, for why market sentiment is NOT here.
export default function EconTerminal({ brief, symbol }) {
  if (!brief || brief.events.length === 0) return null

  const title = brief.highCount > 0
    ? `${brief.highCount} high-impact US release${brief.highCount === 1 ? '' : 's'} today`
    : 'US calendar today'

  return (
    <div className="econ-term">
      <div className="econ-term-bar">
        <span className="econ-term-lights" aria-hidden="true">
          <span className="econ-term-light econ-term-light-close" />
          <span className="econ-term-light econ-term-light-min" />
          <span className="econ-term-light econ-term-light-zoom" />
        </span>
        <span className="econ-term-title">{title}</span>
      </div>

      <div className="econ-term-body">
        {brief.events.map(({ event, timestamp, meaning, framing, bias }) => (
          <div className="econ-term-block" key={event.event_key}>
            {/* The command line is a label, not a prompt the user can type
                into - it names what the block below is, in the idiom of the
                window it sits in. */}
            <div className="econ-term-cmd">
              <span className="econ-term-prompt">$</span>
              {` outlook --release "${event.title}"`}
            </div>

            <div className="econ-term-headline">
              <span className={`econ-term-impact econ-term-impact-${event.impact}`}>
                {event.impact === 'high' ? 'HIGH' : 'MED'}
              </span>
              <span className="econ-term-name">{event.title}</span>
              <span className="econ-term-clock">{clockFor(timestamp)}</span>
            </div>

            <Row label="what">{meaning.what}</Row>
            <Row label="moves">{meaning.affects}</Row>

            {/* Figures on one line so they line up down the block - the
                single thing monospace is actually here for. */}
            {event.forecast || event.previous ? (
              <Row label="fcast">
                <span className="econ-term-fig">{event.forecast || '—'}</span>
                <span className="econ-term-dim">{'  prev '}</span>
                <span className="econ-term-fig">{event.previous || '—'}</span>
              </Row>
            ) : null}

            {/* The real record of this release against its own forecast.
                Absent until there are at least three past prints to read -
                see consensusBias. */}
            {bias ? (
              <Row label="record">
                <span className="econ-term-dim">{`last ${bias.prints}: `}</span>
                {bias.verdict}
              </Row>
            ) : null}

            {framing ? <Row label="read">{framing}</Row> : null}

            {event.actual ? (
              <Row label="actual" emphasis>
                <span className="econ-term-fig">{event.actual}</span>
                {event.forecast ? (
                  <span className="econ-term-dim">{`  vs ${event.forecast} forecast`}</span>
                ) : null}
              </Row>
            ) : event.forecast ? (
              // Only a release that HAS a forecast has a figure to wait
              // for. A speech never publishes one, so it said "awaiting
              // release" for ever, including hours after it had finished.
              <Row label="status"><span className="econ-term-dim">awaiting release</span></Row>
            ) : null}
          </div>
        ))}

        {/* Says where the numbers come from, so nothing in the window reads
            as a market call. */}
        <div className="econ-term-foot">
          <span className="econ-term-prompt">$</span>
          {` source forexfactory · figures as published${symbol ? ` · ${symbol}` : ''}`}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children, emphasis = false }) {
  return (
    <div className={`econ-term-row${emphasis ? ' is-emphasis' : ''}`}>
      <span className="econ-term-label">{label}</span>
      <span className="econ-term-value">{children}</span>
    </div>
  )
}

// An all-day row arrives at local midnight and has no instant to quote.
function clockFor(timestamp) {
  const d = new Date(timestamp)
  if (d.getHours() === 0 && d.getMinutes() === 0) return 'all day'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
