// Full-panel replacement for a page's content when its initial data fetch
// fails, so the page never sits silently blank or stuck on a spinner. Pairs
// with a `retry` callback that just re-runs the same load function.
export default function PageError({ message = "Couldn't load this page — something went wrong.", onRetry }) {
  return (
    <div className="panel page-error">
      <p className="page-error-message">{message}</p>
      {onRetry && (
        <button type="button" className="btn-accent-outline" onClick={onRetry}>Retry</button>
      )}
    </div>
  )
}
