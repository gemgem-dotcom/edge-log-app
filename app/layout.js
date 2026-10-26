// In Next.js, layout.js wraps every page. It's where you put things
// that should appear everywhere: the <html> tag, global styles, fonts.
// We only have one page right now, but this structure is what lets you
// add more pages later without repeating this boilerplate each time.

import './globals.css'
import ToastContainer from '@/components/ToastContainer'

export const metadata = {
  title: 'EdgeLog',
  description: 'Discretionary trade journal',
  // Launched from an iPhone home screen, open without Safari's chrome.
  // `title` is the label under the icon; without it iOS falls back to the
  // <title>, which is the same string today but would drift if that ever
  // grew a page-name suffix.
  //
  // statusBarStyle 'black' and not 'black-translucent' on purpose. Translucent
  // extends the page *under* the status bar, and .shell-topbar is
  // position:fixed with no top inset, so the clock and battery would sit on
  // top of it. 'default' would be worse still: a white bar above an app that
  // defaults to the dark theme. 'black' matches that default and leaves iOS to
  // reserve the bar, so no layout changes anywhere.
  appleWebApp: {
    capable: true,
    title: 'EdgeLog',
    statusBarStyle: 'black',
  },
  // This Next version emits only `mobile-web-app-capable` for the above, which
  // iOS honours from 16.4. The legacy spelling is what everything older reads,
  // and it is one tag - verify against metadata.js before assuming Next has
  // started emitting it itself.
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Deliberately NOT viewportFit: 'cover'. The three env(safe-area-inset-*)
  // calls in globals.css (the mobile tab bar and the two sheets) only ever
  // return a non-zero value under 'cover' - without it iOS insets the web view
  // itself and the 0px fallbacks are correct. Turning it on would hand the page
  // the full screen, and the fixed topbar has no top inset to give back.
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
