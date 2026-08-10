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
