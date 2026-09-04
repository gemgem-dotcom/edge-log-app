// The only page in the app with no client-side interactivity, so it stays a
// server component and sets its title via metadata directly, instead of the
// usePageTitle hook every other (client component) page uses.
//
// No longer linked from the sidebar (its real feature isn't built yet) but
// left in place, reachable by direct URL, so re-adding the nav link later
// is a cheap revert - see app/app/[instrument]/layout.js and
// components/AppShell.js.
export const metadata = { title: 'EdgeLog — Insights' }

export default function InsightsPage() {
  return (
    <div className="page-container">
      <h1 className="page-title">Insights</h1>
      <div className="panel">
        <div className="empty">
          Not available yet.
        </div>
      </div>
    </div>
  )
}
