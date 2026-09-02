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
// app/signup/page.js's signUp call and markTutorialPendingIfNewAccount
// below, used by app/auth/callback/page.js) - never derived here.
export function readTutorialState(user) {
  const status = user?.user_metadata?.tutorial_status ?? 'done'
  const step = user?.user_metadata?.tutorial_step ?? 0
  return { status, step }
}

// The moment the user taps through the Welcome screen.
export async function startTutorial() {
  await supabase.auth.updateUser({ data: { tutorial_status: 'active', tutorial_step: 0 } })
}

export async function setTutorialStep(step) {
  await supabase.auth.updateUser({ data: { tutorial_step: step } })
}

// Step 3 completing and "Exit tutorial" both land here - exiting doesn't
// fake-complete a step, it just turns off the guidance permanently (see
// TutorialOverlay.js's own comment). Never transitions back to 'pending'
// or 'active' once done.
export async function completeTutorial() {
  await supabase.auth.updateUser({ data: { tutorial_status: 'done' } })
}

// Google OAuth has no separate "create account" call the way email/
// password signUp() does - the very first successful sign-in for a given
// identity IS the account creation, so the callback page (the one place
// that sees a freshly-authenticated OAuth user) is the only hook available
// for it. created_at and last_sign_in_at land within moments of each other
// only on that first-ever sign-in; a returning user's created_at is always
// far older than "now". Getting the direction of this wrong would be the
// one genuinely bad outcome (see readTutorialState's own comment), so this
// only ever ADDS tutorial_status when it's entirely absent, and the window
// is deliberately tight - a false negative (an actual new user not getting
// the tutorial) is a far smaller loss than a false positive.
//
// Takes `client` rather than importing the shared supabase singleton,
// since the one caller (app/auth/callback/page.js) deliberately uses its
// own isolated client instance - see that file's own comment on why.
const NEW_ACCOUNT_WINDOW_MS = 60000
export async function markTutorialPendingIfNewAccount(client, user) {
  if (!user || user.user_metadata?.tutorial_status) return
  const created = new Date(user.created_at).getTime()
  const lastSignIn = new Date(user.last_sign_in_at).getTime()
  if (Number.isNaN(created) || Number.isNaN(lastSignIn)) return
  if (Math.abs(lastSignIn - created) > NEW_ACCOUNT_WINDOW_MS) return
  await client.auth.updateUser({ data: { tutorial_status: 'pending' } })
}
