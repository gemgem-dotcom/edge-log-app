'use client'

import { useState } from 'react'

// Full-viewport, full-stop screen: first used exactly once, right after the
// name step, for a user whose tutorial has never been shown (see
// lib/tutorial.js), and reused as-is for the closing screen shown after
// tutorial step 3 (app/app/page.js) - same visual language and tap-to-
// continue mechanics, different copy, so title/subtitle/actionLabel are the
// caller's job rather than hardcoded here. Rendered as a sibling on top of
// the (already-mounted) page underneath rather than a route of its own, so
// tapping through cross-fades into it instead of navigating - the page
// should feel like it was always there, being revealed, not navigated to.
//
// onContinue fires immediately on tap (the caller does whatever "the
// moment the user taps through" means for it - starting the tutorial, or
// nothing at all); onDone fires once the fade-out has actually finished,
// which is when the caller unmounts this component. Two callbacks rather
// than one so the visual fade isn't at the mercy of how fast the state
// update that follows it happens to re-render.
const FADE_MS = 450

export default function WelcomeTransition({ title, subtitle, actionLabel, onContinue, onDone }) {
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
        <h1 className="welcome-transition-title">{title}</h1>
        <p className="welcome-transition-subtitle">{subtitle}</p>
        <button type="button" className="welcome-transition-btn" onClick={handleContinue}>
          {actionLabel}
        </button>
      </div>
    </div>
  )
}
