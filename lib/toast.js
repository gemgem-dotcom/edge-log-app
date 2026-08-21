// Minimal pub-sub so any component can fire a toast without wiring up a
// context provider - ToastContainer (mounted once in the root layout) is
// the only subscriber.
let listeners = []
let idCounter = 0

function emit(message, type) {
  const item = { id: ++idCounter, message, type }
  listeners.forEach((fn) => fn(item))
}

export function subscribeToast(fn) {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

export const toast = {
  success: (message) => emit(message, 'success'),
  error: (message) => emit(message, 'error'),
}

const RETURN_QUEUE_KEY = 'edgelog-toast-on-return'

// For a toast fired right before router.back(), rather than router.push():
// this app links into pages with plain <a> tags (no next/link), so the page
// being returned to is a genuine prior browser-navigation entry, not one
// Next.js soft-navigated to - going back to it doesn't reliably re-run the
// in-memory emit() above the way a toast fired before a router.push does,
// silently swallowing it. Queuing it in sessionStorage instead lets
// ToastContainer's own pathname-keyed effect pick it up on the other side
// of the navigation, whether or not that in-memory path fired too.
export function queueToastForReturn(message, type = 'success') {
  try {
    sessionStorage.setItem(RETURN_QUEUE_KEY, JSON.stringify({ message, type }))
  } catch {
    // Storage can be unavailable (private-mode restrictions) - a missed
    // toast on the way back beats throwing over it.
  }
}

export function takeQueuedReturnToast() {
  try {
    const raw = sessionStorage.getItem(RETURN_QUEUE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(RETURN_QUEUE_KEY)
    const { message, type } = JSON.parse(raw)
    return { id: ++idCounter, message, type }
  } catch {
    return null
  }
}
