// Full-page loading screen shown while a route's data is still fetching.
// Kept as one shared component so every page renders the identical
// wording/animation instead of each hand-rolling its own <div>.
export default function PageLoading() {
  return (
    <div className="page-loading">
      <div className="page-loading-bars">
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} />
        ))}
      </div>
      <div className="page-loading-label">Loading</div>
    </div>
  )
}
