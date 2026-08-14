import { useState, useEffect } from 'react'

// Matches the app's 640px mobile breakpoint (see globals.css). Real mobile
// browsers don't support typing into input[type=date]/[type=time] at all -
// tapping the field opens the OS's own picker instead, with no keyboard
// segment entry and no placeholder shown - unlike desktop, where typing
// into the native input works well. DatePicker/TimePicker use this to
// swap in a typed text fallback there, while leaving desktop's native
// input untouched.
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    setIsMobile(mq.matches)
    const onChange = (e) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
