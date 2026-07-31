// In Next.js, layout.js wraps every page. It's where you put things
// that should appear everywhere: the <html> tag, global styles, fonts.
// We only have one page right now, but this structure is what lets you
// add more pages later without repeating this boilerplate each time.

import './globals.css'

export const metadata = {
  title: 'Edge Log',
  description: 'Discretionary trade journal',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
}
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
