// Inline error banner for save/submit failures - the .field-error pattern
// scaled up to a whole-form or whole-action message instead of a native
// alert(). Renders nothing when there's no message, so callers can render
// it unconditionally.
export default function ErrorBanner({ message }) {
  if (!message) return null
  return <div className="error-banner">{message}</div>
}
