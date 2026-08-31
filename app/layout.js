// In Next.js, layout.js wraps every page. It's where you put things
// that should appear everywhere: the <html> tag, global styles, fonts.
// We only have one page right now, but this structure is what lets you
// add more pages later without repeating this boilerplate each time.

import './globals.css'
import ToastContainer from '@/components/ToastContainer'

export const metadata = {
  title: 'EdgeLog',
  description: 'Discretionary trade journal',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before paint — reads the saved theme and applies it
            immediately, so there's no flash of dark-then-light (or
            vice versa) while the page loads. The inline script below sets
            data-theme on this element directly, before React hydrates -
            a deliberate, expected mismatch against the server-rendered
            markup (which has no way to know the saved theme), so
            suppressHydrationWarning tells React not to flag it. Scoped to
            just this element/attribute, not a blanket suppression. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('edgelog-theme') || 'dark';
                  document.documentElement.setAttribute('data-theme', theme);
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body>
        {children}
        <ToastContainer />
      </body>
    </html>
  )
}
