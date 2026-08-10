'use client'

import { useEffect } from 'react'

// Every page in the app is a client component, so per-route metadata (the
// server-only `export const metadata`) isn't available - this sets the
// browser tab title imperatively instead. Falls back to the bare brand name
// when a page hasn't resolved a title yet (e.g. still loading).
export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `EdgeLog — ${title}` : 'EdgeLog'
  }, [title])
}
