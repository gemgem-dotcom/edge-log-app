import Link from 'next/link'

// Shared "nothing here yet" panel content: a short message plus an optional
// call-to-action link, styled to match the rest of the app instead of a
// generic placeholder. Meant to sit inside an existing .panel, not to
// replace one - callers control their own wrapper.
export default function EmptyState({ title, message, actionHref, actionLabel }) {
  return (
    <div className="empty-state">
      {title && <div className="empty-state-title">{title}</div>}
      {message && <p className="empty-state-message">{message}</p>}
      {actionHref && actionLabel && (
        <Link href={actionHref} className="new-trade-btn empty-state-action">{actionLabel}</Link>
      )}
    </div>
  )
}
