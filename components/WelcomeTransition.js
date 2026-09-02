'use client'

import { useState } from 'react'

// Full-viewport first-run screen shown exactly once, right after the name
// step, and only for a user whose tutorial has never been shown (see
// lib/tutorial.js). Rendered as a sibling on top of the (already-mounted,
// now-empty) dashboard rather than a route of its own, so tapping through
// cross-fades into it instead of navigating - the dashboard should feel
// like it was always there, being revealed, not navigated to.
//
// onContinue fires immediately on tap (the caller starts the tutorial
// right then, matching the state model's "the moment the user taps
// through"); onDone fires once the fade-out has actually finished, which
// is when the caller unmounts this component. Two callbacks rather than
// one so the visual fade isn't at the mercy of how fast the state update
// that follows it happens to re-render.
const FADE_MS = 450

export default function WelcomeTransition({ name, onContinue, onDone }) {
  const [leaving, setLeaving] = useState(false)

  function handleContinue() {
    onContinue()
    setLeaving(true)
    setTimeout(onDone, FADE_MS)
  }

  return (
    <div
      className={`welcome-transition ${leaving ? 'welcome-transition-leaving' : ''}`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <div className="welcome-transition-content">
        <h1 className="welcome-transition-title">Welcome{name ? `, ${name}` : ''}</h1>
        <p className="welcome-transition-subtitle">Let&apos;s get your trading journal set up.</p>
        <button type="button" className="welcome-transition-btn" onClick={handleContinue}>
          Let&apos;s get started.
        </button>
      </div>
    </div>
  )
}
