import { supabase } from '@/lib/supabaseClient'

// Real, existing UI is what each step spotlights - no fake simulation of
// the app built just for the tour. targetSelector matches a
// data-tutorial-target attribute added directly to that real control:
// InstrumentNav.js's "+ Add instrument" trigger, app/app/[instrument]/
// layout.js's sidebar "+ Add new" strategy trigger, and the "Log new
// trade" button on app/app/[instrument]/dashboard/page.js. Order matters -
// it's also the tutorial_step index (0-2) stored on the user.
// expandSelector covers a step whose real interaction happens in a second
// element the trigger opens rather than in the trigger itself - the
// spotlight has to grow to include it too, or the tutorial's own scrim
// would block the very thing it just told the user to fill in.
// InstrumentNav's "+ Add instrument" opens a separate, position:fixed
// dropdown (its own element, not a resize of the trigger); the sidebar's
// "+ Add new" swaps itself out for the strategy-name form entirely, so
// only the expandSelector is left to find once that happens - see
// TutorialOverlay.js's measure() for how both are unioned.
export const TUTORIAL_STEPS = [
  {
    targetSelector: '[data-tutorial-target="add-instrument"]',
    expandSelector: '.instrument-dropdown',
    title: 'Add your first instrument',
    message: 'Pick the futures contract you trade most. We’ll take you straight to its dashboard.',
  },
  {
    targetSelector: '[data-tutorial-target="add-strategy"]',
    expandSelector: '.sidebar-strategy-add-form',
    title: 'Add your first strategy',
    message: 'Name a setup you trade so you can track its performance separately from everything else.',
  },
  {
    targetSelector: '[data-tutorial-target="log-trade"]',
    title: 'Log your first trade',
    message: 'Record a trade to start building your stats.',
  },
]

// Reads a user's onboarding-tutorial progress from Supabase auth
// user_metadata, mirroring how app/app/page.js already reads/writes
// user_metadata.full_name - this is small, per-user, non-relational state,
// so it doesn't need a schema.sql table.
//
// Absent tutorial_status defaults to 'done', not 'pending' - load-bearing:
// every user who existed before this feature shipped has no
// tutorial_status at all, and defaulting it to anything but 'done' would
// force a returning trader who simply archived every instrument back
// through a beginner tutorial. tutorial_status is only ever explicitly set
// to 'pending' at the moment a brand-new account is created (see
// app/signup/page.js's signUp call and lib/tutorialNewAccount.js's
// markTutorialPendingIfNewAccount, used by app/auth/callback/page.js) -
// never derived here.
export function readTutorialState(user) {
  const status = user?.user_metadata?.tutorial_status ?? 'done'
  const step = user?.user_metadata?.tutorial_step ?? 0
  return { status, step }
}

const LOCAL_STATE_KEY = 'edgelog-tutorial-state'

// Every page that spotlights part of the tutorial (app/app/page.js,
// app/app/[instrument]/layout.js, app/app/[instrument]/log/new/page.js)
// only learns the real tutorial_status/tutorial_step after its own
// supabase.auth.getUser() call resolves - on a fresh mount (a real
// navigation, not a client-side transition within the same layout), that
// async gap showed up as a visible beat of no dimming/glow at all right
// after clicking through to the next step, before the overlay "popped in".
// Mirroring the last-known state into sessionStorage (same mechanism
// queueClosingScreen below already uses) lets each of those mounts seed
// its very first render from this cache instead of the
// hardcoded {status:'done',step:0} default, so the overlay is already
// correct on the first paint; the real fetch still runs right after to
// confirm/correct it (e.g. a stale cache from another device or a cleared
// tutorial). Every write to the real state below goes through here too, so
// the cache never lags behind what was just set in the same session.
export function cacheTutorialState(state) {
  try {
    sessionStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be unavailable (private-mode restrictions) - falling
    // back to the real fetch's usual small delay beats throwing over it.
  }
}

export function readCachedTutorialState() {
  try {
    const raw = sessionStorage.getItem(LOCAL_STATE_KEY)
    return raw ? JSON.parse(raw) : { status: 'done', step: 0 }
  } catch {
    return { status: 'done', step: 0 }
  }
}

// The moment the user taps through the Welcome screen.
export async function startTutorial() {
  const state = { status: 'active', step: 0 }
  cacheTutorialState(state)
  await supabase.auth.updateUser({ data: { tutorial_status: state.status, tutorial_step: state.step } })
}

export async function setTutorialStep(step) {
  cacheTutorialState({ status: 'active', step })
  await supabase.auth.updateUser({ data: { tutorial_step: step } })
}

// Step 3 completing and "Exit tutorial" both land here - exiting doesn't
// fake-complete a step, it just turns off the guidance permanently (see
// TutorialOverlay.js's own comment). Never transitions back to 'pending'
// or 'active' once done.
export async function completeTutorial() {
  cacheTutorialState({ status: 'done', step: 0 })
  await supabase.auth.updateUser({ data: { tutorial_status: 'done' } })
}

const CLOSING_SCREEN_KEY = 'edgelog-tutorial-show-closing'

// Signals the all-instruments Overview page (app/app/page.js) to show the
// closing screen once it lands there, right after step 3 completes (see
// app/app/[instrument]/log/new/page.js's tap-to-continue handler). A
// router.push-then-read-a-?query-param approach was tried first and didn't
// reliably survive a real production soft navigation to a fully static
// route - sessionStorage sidesteps that entirely and mirrors the same
// queue-for-next-page pattern lib/toast.js already uses for its own
// return-navigation toasts (queueToastForReturn/takeQueuedReturnToast).
export function queueClosingScreen() {
  try {
    sessionStorage.setItem(CLOSING_SCREEN_KEY, '1')
  } catch {
    // Storage can be unavailable (private-mode restrictions) - missing the
    // closing screen beats throwing over it.
  }
}

export function takeQueuedClosingScreen() {
  try {
    const shouldShow = sessionStorage.getItem(CLOSING_SCREEN_KEY) === '1'
    sessionStorage.removeItem(CLOSING_SCREEN_KEY)
    return shouldShow
  } catch {
    return false
  }
}

// markTutorialPendingIfNewAccount lives in lib/tutorialNewAccount.js, not
// here, despite being conceptually part of this same state model - see
// that file's own comment for why importing it must never also import
// this file's top-level shared `supabase` client.
