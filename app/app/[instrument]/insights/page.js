export default function InsightsPage({ params }) {
  return (
    <div className="page-container">
      <h1 className="page-title">{params.instrument} — Insights</h1>
      <div className="panel">
        <div className="empty">
          This is where the AI pattern-discovery output will eventually live (Phases 4–7).
          Placeholder for now.
        </div>
      </div>
    </div>
  )
}
