// The only page in the app with no client-side interactivity, so it stays a
// server component and sets its title via metadata directly, instead of the
// usePageTitle hook every other (client component) page uses.
export const metadata = { title: 'EdgeLog — Insights' }

export default function InsightsPage() {
  return (
    <div className="page-container">
      <h1 className="page-title">Insights</h1>
      <div className="panel">
        <div className="empty">
          This is where the AI pattern-discovery output will eventually live (Phases 4–7).
          Placeholder for now.
        </div>
      </div>
    </div>
  )
}
