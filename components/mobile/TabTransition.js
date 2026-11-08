'use client'

// Tab switches are an INSTANT SWAP. This component is the record of why,
// because the obvious improvement is to put the slide back.
//
// It used to wrap each screen in a React <ViewTransition>, keyed on the
// pathname, so the outgoing and arriving screens cross-faded and slid 32px.
// It shipped two user-visible regressions in one day, both the same shape:
// the two screens were briefly painted ON TOP OF EACH OTHER, headings
// superimposed into an unreadable smear. Photographed on a real phone,
// twice.
//
// WHY IT KEPT COMING BACK. A cross-fade between two screens is, by
// definition, a window in which both are partly visible. That window was
// harmless for exactly as long as the arriving screen was a SKELETON at
// that moment - pale grey bars under text read as loading. The moment
// arriving screens started painting real content immediately (the tab
// caches), the same window blended two dense pages of text.
//
// Sequencing the two fades so they could not run at once was tried, and
// was not enough. React keys the two screens as separate elements, so it
// emits an EXIT group and a separate ENTER group with different names
// (measured: ::view-transition-old(_t_3_) against
// ::view-transition-new(_t_4_)) rather than one paired group. They are
// independent, their timing is not something one pair of CSS rules
// reliably governs, and which groups appear at all depends on the route
// and on whether the boundary happened to be mounted - /app, /app/log,
// /app/strategies and /app/account each render their own AppShell, so the
// boundary survives some navigations and not others. Measured: the same
// Account -> Overview tap produced the named groups when reached by a
// soft navigation and no groups at all when reached by a fresh load.
//
// A transition whose behaviour depends on how you arrived at the screen
// cannot be made consistent by tuning it, and consistency is the whole
// requirement. So there is no transition. An instant swap cannot overlap,
// looks the same on every route, and is what the desktop already does.
//
// IF YOU REINSTATE IT, the bar is: capture composited frames with CDP
// Page.startScreencast - NOT Playwright page.screenshot(), which captures
// the DOM paint and not the compositor's view-transition layers, returns
// clean frames while this bug is live, and is how it shipped the first
// time. Check mid-animation, on a warm tab, a cold tab, an instrument
// route and a fresh load of each.
export default function TabTransition({ children }) {
  return children
}
