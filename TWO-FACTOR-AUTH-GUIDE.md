# Two-Factor Authentication for a Supabase + Next.js App

### A complete build guide, written for someone who has never done this before

---

This guide takes you from an app with password-only login to one with working
two-factor authentication that you could put in front of real users. It assumes
you can write React and have a Supabase project, and assumes nothing else. Every
concept is explained the first time it appears.

It is written from an implementation that is live. Where something is stated as a
fact about Supabase's behaviour, it was **measured against a real project**, and
the guide says so and gives you the script to measure it yourself. Where
something is an assumption, the guide says that too. This matters more than it
sounds: most of the expensive mistakes below came from believing something
plausible about the auth server without checking it.

**Read sections 1 to 3 before writing any code.** They are short, and they
contain the two decisions that are painful to change later.

---

## Table of contents

**Part I — Decide before you build**
1. [What you are actually building](#1-what-you-are-actually-building)
2. [How TOTP works, in two minutes](#2-how-totp-works-in-two-minutes)
3. [The one concept you must understand: AAL](#3-the-one-concept-you-must-understand-aal)
4. [The decision that shapes everything: what happens when someone loses their phone](#4-the-decision-that-shapes-everything)
5. [Find out what your auth server can actually do](#5-find-out-what-your-auth-server-can-actually-do)

**Part II — Build it**
6. [Setup](#6-setup)
7. [Flow 1 — Turning 2FA on](#7-flow-1--turning-2fa-on)
8. [Flow 2 — Logging in](#8-flow-2--logging-in)
9. [Flow 3 — Turning 2FA off](#9-flow-3--turning-2fa-off)
10. [The trap: enforcing 2FA in only one place](#10-the-trap-enforcing-2fa-in-only-one-place)
11. [Account recovery: the password reset that clears 2FA](#11-account-recovery)
12. [Rate limiting, and what it can honestly do](#12-rate-limiting)
13. [Remember this browser for 30 days](#13-remember-this-browser)

**Part III — Make it good**
14. [Styling: the QR code and everything around it](#14-styling)
15. [Words: writing for someone who does not know what any of this is](#15-words)
16. [Accessibility](#16-accessibility)
17. [Testing it properly](#17-testing-it-properly)
18. [Mistakes that cost us real time](#18-mistakes-that-cost-us-real-time)
19. [What is deliberately not here](#19-what-is-deliberately-not-here)

---

# Part I — Decide before you build

## 1. What you are actually building

When two-factor authentication is on, signing in takes two steps instead of one:

1. Email and password, as before.
2. A six-digit code from an app on the user's phone.

The second step is what makes a stolen password insufficient. The code changes
every thirty seconds and is generated on the phone itself, so an attacker needs
the password *and* physical possession of the device.

You are building three flows, plus four things that are easy to skip and
shouldn't be:

| | What it is |
|---|---|
| **Enrolment** | User scans a QR code, types a code back, 2FA is on |
| **Challenge** | User logs in, is asked for a code |
| **Disable** | User turns it off |
| **Enforcement** | Making the challenge actually unavoidable — §10 |
| **Recovery** | What happens when the phone is lost — §4 and §11 |
| **Rate limiting** | Stopping someone guessing codes — §12 |
| **Remember this browser** | Not asking every single time — §13 |

Most guides stop after the first three. The first three are about a third of the
work, and on their own they produce something that *looks* finished and has a way
in beside the front door. §10 is the one to read if you read nothing else.

---

## 2. How TOTP works, in two minutes

TOTP is "Time-based One-Time Password". It is the thing Google Authenticator,
Authy, 1Password and the rest all implement.

**Setup.** The server generates a random secret and shows it to the user as a QR
code. The user's app scans it and stores the secret. Both sides now hold the same
secret, and it never travels again.

**Generating a code.** The app takes the current time, rounds it down to a
30-second window, and hashes it with the secret. The result is six digits. The
server can do the same calculation, so it knows what the code should be without
ever asking the phone.

Three consequences that matter when you write the UI:

- **The code is not sent anywhere to be created.** It works on a plane. There is
  no SMS, no email, nothing to intercept.
- **It expires.** A code is valid for its 30-second window, usually with a small
  grace period either side. "The code I typed was correct and it still said
  wrong" is almost always a code that aged out, or a phone whose clock has
  drifted. Your error message should say so — see §15.
- **Codes can start with a zero.** Use `type="text"` with `inputMode="numeric"`,
  never `type="number"`, which will silently eat a leading zero and leave the
  user staring at a five-digit code that never works.

The secret Supabase generates is also shown as text, for users whose phone camera
is broken or who are setting up on the same device they are reading on. Do not
omit it.

---

## 3. The one concept you must understand: AAL

**AAL is Authenticator Assurance Level.** It is one claim inside the user's
access token, and almost every mistake in this area comes from misunderstanding
it.

- `aal1` — the user proved *one* thing. Password, or Google sign-in.
- `aal2` — the user proved *two*. Password **and** a code.

Supabase gives you this:

```js
const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
// { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [...] }
```

- `currentLevel` — what this session has proved **so far**
- `nextLevel` — what it **could** reach, which is `aal2` if the account has any
  verified factor

So the test for "does this person still owe me a code" is:

```js
nextLevel === 'aal2' && currentLevel !== 'aal2'
```

**Do not test "does this account have a factor".** That reads as the same thing
and is not. Once the user has entered their code, `currentLevel` becomes `aal2`
but the factor still exists — so a check written that way keeps challenging a
user who has already answered, forever, with no way out. This is the single most
common way to lock yourself out of your own app while building this.

Three more facts about AAL, each of which has a consequence later:

- **Signing in with a password always produces `aal1`**, even on an account with
  2FA. That is the whole point: §10 and §11 both depend on it.
- **Supabase requires `aal2` to unenroll a factor.** A user who cannot produce a
  code therefore cannot remove their own authenticator. This is why §11 needs a
  server route.
- **There is no way to reach `aal2` without entering a code.** No API, no admin
  call that elevates a live session. §13's "remember this browser" works around
  this rather than solving it, and the difference matters.

---

## 4. The decision that shapes everything

### What happens when someone loses their phone?

Decide this **now**. It changes your schema, your routes and your UI, and
retrofitting it is miserable.

Two-factor authentication means the user needs something they have. People lose
things they have. If you have no answer here, the first user who drops their
phone in a river loses their account permanently, and you will find out by email.

The three real options:

| Option | What it costs |
|---|---|
| **Backup codes** | Ten one-time codes shown once at setup. Strongest. But it is a lot of machinery to put in front of a non-technical person, and most are lost before they are needed — so you carry the complexity and still get the support email. |
| **Password reset clears 2FA** | The reset email becomes the way back in. Simple, nothing for the user to keep. Cost: 2FA now protects against a stolen *password*, not a compromised *inbox*. |
| **Manual support** | You fix it by hand in the Supabase dashboard. Fine for ten users; a job for a thousand. |

**This guide implements the second**, because the app it came from is used by
people who would lose a sheet of backup codes. That is a product decision, not a
security best practice — be honest with yourself about which you are making.

If you choose it, understand exactly what you are trading: **anyone who controls
the user's email can get into the account.** They reset the password, the reset
clears the second factor, and they are in. For a trading journal that is an
acceptable trade. For something holding money it is not — use backup codes.

And note the trap in the middle option, which §11 is entirely about: **a password
reset that does *not* clear the factor is worse than useless.** The user sets a
new password, is immediately asked for a code they cannot produce, and is locked
out by the very flow meant to rescue them. If you pick this route you must
implement the clearing, or you have built a dead end that looks like a door.

---

## 5. Find out what your auth server can actually do

Before building anything, find out what your project supports. The client library
can express far more than any given server implements, and a beautiful screen
built against an endpoint that returns 404 is worse than no screen, because it
looks finished.

Save this as `scripts/probe-auth-capabilities.js` and run it with your project's
URL and anon key:

```js
#!/usr/bin/env node
// Read-only. Sends no credential beyond the public anon key, creates
// nothing, signs nobody in.
//
// Each endpoint is called WITHOUT a session. The status tells you about
// the FEATURE rather than about your request:
//   404  no such route here        -> NOT available
//   401  exists, wants a session   -> AVAILABLE
//   400  exists, wants a body      -> AVAILABLE
//   403  exists, disabled in config
//
// A 401 is therefore a PASS, which reads oddly in a log and is the
// whole trick: the question is "does this door exist", not "will it
// let me in".

const FAKE = '00000000-0000-0000-0000-000000000000'
const PROBES = [
  ['GET',  '/health',                      'the server answers at all'],
  ['GET',  '/settings',                    'what the project has switched on'],
  ['POST', '/factors',                     'enroll a factor'],
  ['POST', `/factors/${FAKE}/challenge`,   'challenge a factor'],
  ['POST', `/factors/${FAKE}/verify`,      'verify a challenge'],
  ['DELETE', `/factors/${FAKE}`,           'unenroll a factor'],
  ['GET',  '/reauthenticate',              'reauthenticate'],
  ['GET',  '/passkeys',                    'list passkeys'],
  ['POST', '/passkeys/registration/options', 'passkey registration'],
]

const base = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '') + '/auth/v1'
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

for (const [method, path, what] of PROBES) {
  const res = await fetch(base + path, {
    method,
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  })
  const verdict =
    res.status === 404 ? 'NOT AVAILABLE - no such route' :
    res.status === 401 ? 'available (refused us, correctly)' :
    res.status === 400 ? 'available (rejected our empty body)' :
    res.status === 403 ? 'present but disabled in config' :
    res.status === 200 ? 'OK' : `inconclusive - ${res.status}`
  console.log(`${method.padEnd(6)} ${what.padEnd(34)} ${String(res.status).padEnd(4)} ${verdict}`)

  // /health carries the auth server VERSION, which is the most useful
  // line in the output: a 404 on a route your client library knows
  // about means the server is older than the client.
  if (path === '/health' && res.ok) {
    const h = await res.clone().json().catch(() => null)
    if (h) console.log(`       auth server: ${h.name || 'gotrue'} ${h.version || '(not reported)'}`)
  }
  await new Promise((r) => setTimeout(r, 250))
}
```

Run it from a CI job or a trusted machine rather than pasting production keys
into a terminal.

**What we found running this**, as an example of why it is worth doing: TOTP,
recovery codes and reauthenticate all answered 401 — present. All five
`/passkeys*` routes answered **404**. The client library (`@supabase/auth-js`
2.118) has a full passkey API; the server (**GoTrue v2.197.0**) had no such
routes. Two days of passkey work avoided by a script that took twenty minutes.

---

# Part II — Build it

## 6. Setup

### 6.1 Turn MFA on in Supabase

Dashboard → **Authentication** → **Multi-Factor Authentication** (older projects
call it "MFA / TOTP"). Enable TOTP. Nothing works until this is on, and the
failure is an unhelpful error from `enroll()`.

### 6.2 You need a session-persisting browser client

```js
// lib/supabaseClient.js
import { createBrowserClient } from '@supabase/ssr'

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { flowType: 'pkce' } },
)
```

**Use `@supabase/ssr`'s `createBrowserClient`, not `createClient`.** It persists
the session in **cookies** rather than `localStorage`, and §10's server-side gate
is impossible without that — middleware can read cookies and cannot read
`localStorage`. If you are on `createClient` today, switch now rather than later.

### 6.3 Factors live in Supabase, not in your database

Supabase stores the factors itself. You do not need a table for them.

You *will* need two small tables later — one for rate limiting (§12) and one for
remembered browsers (§13) — but neither stores anything about the factor itself.

---

## 7. Flow 1 — Turning 2FA on

### 7.1 Start enrolment

```js
const { data, error } = await supabase.auth.mfa.enroll({
  factorType: 'totp',
  friendlyName: 'Personal phone',
})
// data.id            the factor id — you need this to verify
// data.totp.qr_code  an SVG data: URI, ready for <img src={...}>
// data.totp.secret   the same secret as text, for manual entry
```

Two things that will bite you:

**An abandoned enrolment blocks the next one.** If the user starts setup and
closes the tab, an *unverified* factor is left behind, and the next `enroll()`
call fails. Clear them first, and re-read from the server rather than trusting
local state — another tab may have enrolled since this page loaded:

```js
async function startEnrolment() {
  const { data: current } = await supabase.auth.mfa.listFactors()
  for (const stale of (current?.totp || []).filter((f) => f.status !== 'verified')) {
    await supabase.auth.mfa.unenroll({ factorId: stale.id })
  }
  // ...now enroll
}
```

**A duplicate `friendlyName` is rejected *after* the code is checked.** The
server accepts the correct code, then refuses the name, and your UI says
"incorrect code" about a code that was right. Validate the name *before* you send
the code:

```js
async function verify() {
  const nameProblem = validateName(deviceName, otherFactors)
  if (nameProblem) { setError(nameProblem); return }   // before, not after
  // ...challenge and verify
}
```

### 7.2 Verify

Two calls. `challenge()` opens a window; `verify()` answers it.

```js
const { data: challenge } = await supabase.auth.mfa.challenge({ factorId })
const { error } = await supabase.auth.mfa.verify({
  factorId,
  challengeId: challenge.id,
  code: code.trim(),
})
```

On success the factor becomes `verified`, and **this session is promoted to
aal2** — which is what lets the same screen then offer "remember this browser"
(§13).

### 7.3 Let them name the device, at enrolment

Ask for a device name **on the enrolment screen**, not afterwards. With more than
one authenticator the list is unreadable without names, and the moment the user
is holding the phone is the only moment they can say which one it is.

### 7.4 Support more than one factor from the start

This is a small amount of work now and an awkward migration later. The code that
reads `factors[0]` works perfectly with one device and is quietly wrong with two:
the second exists on the account, protects nothing the user can see, and cannot
be removed.

```js
// lib/mfaFactors.js — pure functions, so they can be unit tested
export function verifiedFactors(data) {
  return (data?.totp || []).filter((f) => f?.status === 'verified')
}

export function needsSecondFactor(aal) {
  if (!aal) return false
  return aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2'
}

// Which factor to challenge by default: the one most recently used,
// else the oldest. Someone with a phone and a spare tablet reaches for
// the phone, and that is the one they used last.
export function preferredFactor(data) {
  const verified = verifiedFactors(data)
  if (verified.length === 0) return null
  const used = verified.filter((f) => f.last_challenged_at)
  if (used.length) {
    return used.sort((a, b) => new Date(b.last_challenged_at) - new Date(a.last_challenged_at))[0]
  }
  return verified.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]
}
```

Put these in their own file with tests. They are small, they encode real
decisions, and they are the part most likely to be quietly wrong.

---

## 8. Flow 2 — Logging in

After `signInWithPassword` succeeds, ask whether a second factor is owed:

```js
const { error } = await supabase.auth.signInWithPassword({ email, password })
if (error) { /* wrong password */ return }

const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
if (needsSecondFactor(level)) {
  const { data: factors } = await supabase.auth.mfa.listFactors()
  const factor = preferredFactor(factors)
  if (factor) {
    setFactors(verifiedFactors(factors))
    setFactorId(factor.id)
    setStep('mfa')          // show the code field
    return
  }
}
router.push('/app')          // no 2FA on this account
```

Then the code step, which is `challenge()` + `verify()` exactly as in §7.2.

**Offer a way to pick a different device** when more than one is enrolled.
Someone whose phone is flat should be able to reach for the tablet they
deliberately enrolled as a spare; without this the spare is unreachable and
pointless.

**Put a "lost your phone?" link on this screen.** See §15 — this is the single
most important piece of text in the whole feature, and it is the one everybody
forgets.

---

## 9. Flow 3 — Turning 2FA off

```js
await supabase.auth.mfa.unenroll({ factorId })
```

Requires `aal2`. The user is already at aal2 if they signed in with a code, so
from Account settings this just works.

**Warn differently depending on what is being removed.** Removing one of several
authenticators leaves 2FA on; removing the only one turns the protection off.
Same button, two genuinely different consequences — one wording either
over-warns about a tidy-up or under-warns about a security downgrade:

```js
const last = verifiedFactors(data).length === 1
await confirm({
  title: last ? 'Turn Off Two-Factor Authentication' : `Remove ${label}`,
  message: last
    ? 'This is your only authenticator. Removing it turns two-factor authentication off, and makes your account easier to access if your password is ever compromised.'
    : `You will no longer be able to use ${label} to sign in. Your other authenticators keep working.`,
  danger: true,
})
```

---

## 10. The trap: enforcing 2FA in only one place

**This is the section to read twice.**

The natural place to check for a second factor is the login form, because that is
where the user types their password. If you check there and nowhere else, you
have built a door with a gap beside it — and the gap is not theoretical.

Here is the hole, as it existed in a real app for months:

1. Attacker has the user's **email** access, not the password.
2. They request a password reset.
3. They click the link. **Supabase mints a real, live session** — at `aal1`, with
   no code ever presented.
4. The reset page is not `/login`. They never touch the login form.
5. They navigate straight to `/app`.
6. The app asks "is there a session?" — yes — and lets them in.

2FA was switched on the whole time and was never once consulted.

Password recovery is the obvious route, but it is not the only one. Any flow that
produces a session without going through your login form has the same shape:
OAuth callbacks, magic links, email-change confirmations, invites.

### The fix: check assurance in middleware

Put the check where every request passes, not where one form lives. In Next.js
that is `proxy.js` (previously `middleware.js`):

```js
// lib/authAssurance.js — the rule, in one testable place
export function decodeJwtClaims(token) {
  const part = String(token || '').split('.')[1]
  if (!part) return null
  try {
    const b = part.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : ''
    const claims = JSON.parse(Buffer.from(b + pad, 'base64').toString('utf8'))
    return claims && typeof claims === 'object' ? claims : null
  } catch {
    return null   // unreadable means no assurance: fails closed
  }
}

export function verifiedFactorsOf(user) {
  return (user?.factors || []).filter((f) => f && f.status === 'verified')
}

export function sessionNeedsSecondFactor({ claims, user }) {
  if (verifiedFactorsOf(user).length === 0) return false
  return (claims?.aal || 'aal1') !== 'aal2'
}
```

```js
// proxy.js
export async function proxy(request) {
  // ...create the server client, then:
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirectTo('/login')

  let needsSecondFactor = false
  try {
    const { data: { session } } = await supabase.auth.getSession()
    needsSecondFactor = sessionNeedsSecondFactor({
      claims: decodeJwtClaims(session?.access_token),
      user,
    })
  } catch {
    // Fail CLOSED here. Failing open would wave through exactly the
    // sessions this exists to stop.
    needsSecondFactor = verifiedFactorsOf(user).length > 0
  }

  if (needsSecondFactor) return redirectTo('/login?step=2fa')
  return response
}

export const config = { matcher: ['/app', '/app/:path*'] }
```

Four details that matter:

- **`getUser()` before reading claims.** `getUser()` revalidates the token
  against the auth server. Only *after* it passes are the token's own claims
  worth reading. `decodeJwtClaims` deliberately does no verification of its own,
  so it can never be mistaken for the thing that makes a token trustworthy.
- **Unverified factors don't count.** An abandoned enrolment must not lock
  someone out of their account over a QR code they never finished scanning.
- **Fail closed in *this* catch.** Elsewhere in middleware it is right to fail
  open on an outage — a brief unauthenticated page shell beats 500ing every
  visitor. Here it is wrong, for the reason in the comment.
- **`?step=2fa` only decides whether to look.** The login page uses it to jump
  straight to the code field instead of asking for a password the visitor has
  already given. It must never *be* the answer — anyone can type it in the URL
  bar. Key the actual decision off the real assurance level.

```js
// app/login/page.js — arriving already half-authenticated
useEffect(() => {
  if (new URLSearchParams(window.location.search).get('step') !== '2fa') return
  let alive = true
  ;(async () => {
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (!alive || !needsSecondFactor(level)) return     // the real check
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const factor = preferredFactor(factors)
    if (!alive || !factor) return
    setFactorId(factor.id)
    setStep('mfa')
  })()
  return () => { alive = false }
}, [])
```

### Also check your API routes

Middleware covers your pages. Every route under `/api` that returns user data
needs its own thinking — a `matcher` on `/app/*` does nothing for `/api/*`. Go
through them one at a time and write down why each is safe.

We did not, and a reviewer found that **account deletion** — the most
destructive endpoint in the app — accepted an aal1 token. Someone with only
the password could destroy the whole journal without ever seeing a code.

There is a trap in fixing it. The delete button re-authenticated with
`signInWithPassword`, which on an MFA account **lands at aal1** (§3). So
re-authenticating that way *downgrades* the session, and the new aal2 check
would have blocked the very deletion it was gating. Prove identity with a
code instead — `mfa.challenge` + `mfa.verify` elevates the session, so it is
both the proof and the thing the route needs.

### And your row-level security

This is the one most likely to be missed entirely, because everything looks
right. Middleware gates the **pages**. Your Postgres policies almost certainly
look like this:

```sql
create policy "Users manage their own trades"
  on trades for all using (auth.uid() = user_id)
```

`auth.uid()` is satisfied by **any** valid token for that user — aal1 included.
So an attacker with the password skips your app entirely:

```
GET https://<project>.supabase.co/rest/v1/trades?select=*
  apikey: <your anon key, which ships in every page>
  Authorization: Bearer <aal1 token from a password grant>
```

Two-factor authentication protects your UI and your destructive routes. It does
not protect confidentiality unless the policies say so:

```sql
-- aal2, OR the account has no verified factor at all. The second
-- branch is what keeps every password-only user working - without it
-- this locks out everyone who has not set 2FA up.
--
-- And note the direction: coalesce(..., 'aal1') resolves a MISSING
-- claim to aal1, which fails closed here.
create or replace function public.session_meets_assurance()
returns boolean language sql stable security definer
set search_path = auth, public as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f
                     where f.user_id = auth.uid() and f.status = 'verified');
$$;
```

Decide deliberately. If you do not apply it, say so in your own notes — "2FA
protects the app, not the API" is a defensible position and a terrible surprise.

---

### One more place the gate does not reach: the back button

Sign out, press Back, and the app reappears. Nothing has failed — the browser
restored the rendered page from its **back/forward cache**, which runs no
request and therefore passes no gate. The session is gone; the pixels are not.

Two fixes, and use both:

```js
// In the middleware, on EVERY exit path - including the fail-open
// return in the catch, which otherwise keeps serving a cacheable page
// during an outage.
const uncached = (res) => {
  res.headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate')
  return res
}
```

```js
// And in the app shell, because Safari has honoured no-store less
// consistently, and a restored page showing somebody else's data is
// not a thing to leave to one mechanism.
const onPageShow = (e) => {
  if (!e.persisted) return
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session) router.replace('/login')
  })
}
window.addEventListener('pageshow', onPageShow)
```

Check it with `curl -D -` against a running server rather than reading the
code — the header has to be on the redirect too, and it is easy to set it
after an early return.

---

## 11. Account recovery

Given §4's decision, completing a password reset must also clear the user's
factors. Otherwise the reset is a lockout rather than a rescue.

### Why this needs a server route

Supabase requires `aal2` to unenroll, and a recovery session is `aal1` **by
construction** — no code was ever presented. So the user *cannot remove their own
factor*, which is exactly the problem. Only the service role can, and the service
role must never go near a browser.

### Gating it, which is the entire security story

This route switches two-factor authentication off. If someone who merely stole a
password can reach it, you have not built 2FA — you have built a button that
removes it.

The gate uses two claims. **Measure them; do not assume them.** We ran a real
recovery session against the live auth server and got:

```
aal claim     aal1
amr claim     [{"method":"otp","timestamp":1794030562}]
```

`amr` is "Authentication Methods References" — how this session was obtained. A
password sign-in reports `password`; Google reports `oauth`. A recovery link
reports `otp`, because a recovery link *is* a one-time password. Note there is no
`recovery` method in the library's own type union — which is exactly why this
needed measuring rather than guessing.

```js
// lib/authAssurance.js
export const RECOVERY_AMR_METHODS = new Set(['otp', 'recovery'])

export function authMethodsOf(claims) {
  const amr = claims?.amr
  if (!Array.isArray(amr)) return []
  // Supabase emits both [{method,timestamp}] and the RFC-8176 string
  // form, and the library's types say both are possible.
  return amr
    .map((e) => (typeof e === 'string' ? e : e?.method))
    .filter((m) => typeof m === 'string' && m)
    .map((m) => m.toLowerCase())
}

export function isRecoverySession(claims) {
  if (!claims) return false
  // Note: `claims.aal !== 'aal1'`, NOT `(claims.aal || 'aal1') !== 'aal1'`.
  // Defaulting a MISSING claim to aal1 is fail-closed in
  // sessionNeedsSecondFactor, where aal1 means "challenge them". Here
  // aal1 is the PERMISSIVE answer, so the same default is fail-OPEN: a
  // token with no aal claim at all would be handed the power to switch
  // 2FA off. A unit test caught this; nothing else would have.
  if (claims.aal !== 'aal1') return false
  const methods = authMethodsOf(claims)
  // Exactly one method. A session reporting ['password','otp'] is
  // somebody who signed in normally and then did something else, not
  // somebody recovering an account.
  return methods.length === 1 && RECOVERY_AMR_METHODS.has(methods[0])
}
```

> **This is only safe while your app issues no other kind of one-time password.**
> If you add email-code sign-in or a magic link, `otp` stops identifying a
> recovery and this route needs a different proof. Write that in your own notes
> where the next person will find it.

### The route

```js
// app/api/clear-2fa/route.js
export async function POST(req) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return deny(401, 'Not authenticated')

  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY)

  // Revalidates against the auth server. Nothing below trusts the
  // token's contents until this passes.
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return deny(401, 'Invalid session')

  const claims = decodeJwtClaims(token)
  if (!isRecoverySession(claims)) {
    return deny(403, 'This can only be done while completing a password reset')
  }

  const { data: factorData } = await admin.auth.admin.mfa.listFactors({ userId: data.user.id })
  for (const factor of factorData?.factors || []) {
    await admin.auth.admin.mfa.deleteFactor({ userId: data.user.id, id: factor.id })
  }

  // Forget remembered browsers too (§13). A trusted-device row is a
  // standing permission to skip a challenge; once the factors it was
  // granted against are gone, leaving it would let a browser trusted
  // under the old setup sail past whatever gets enrolled next.
  await admin.from('mfa_trusted_device').delete().eq('user_id', data.user.id)

  return Response.json({ success: true })
}
```

Make it **idempotent** — an account with nothing to remove is a success, not an
error — so a user whose first attempt failed partway can request another link and
run it again.

### The reset page

```js
// Order matters: password FIRST, then factors.
//
// Clearing first would mean an abandoned reset silently strips
// someone's 2FA: they open the email, think better of it, close the
// tab, and the account is weaker without them confirming anything.
const { error } = await supabase.auth.updateUser({ password })
if (error) { /* link expired */ return }

if (factorCount > 0) {
  const cleared = await clearTwoFactor()
  if (!cleared) {
    // NEVER report this as success. The password did change, and the
    // way out is another reset link, because the route is idempotent.
    setError('Your password was changed, but two-factor authentication could not be switched off. Request another reset link to finish — your new password still works.')
    return
  }
}
```

And tell them, before they commit, in words rather than jargon — and only when
there is actually a factor to lose. Warning someone about losing something they
do not have is how people learn to click past warnings:

```jsx
{factorCount > 0 && (
  <div className="reset-2fa-warning">
    <div className="reset-2fa-warning-title">
      <ShieldAlert size={15} aria-hidden="true" />
      This will turn off two-factor authentication
    </div>
    <p>
      Your authenticator app will be removed from this account, so you can
      get back in without it. You can set it up again from Account settings
      once you have signed in.
    </p>
    <label className="reset-2fa-accept">
      <input type="checkbox" checked={accepts} onChange={(e) => setAccepts(e.target.checked)} />
      <span>I understand</span>
    </label>
  </div>
)}
```

---

## 12. Rate limiting

### First, find out whether you need it

We assumed Supabase rate-limited MFA verification. We checked: **twenty failing
verify attempts from one IP, no 429, no refusal at all.** So the application
limiter was not a second layer — it was the only one.

Measure yours before deciding how much to trust it:

```js
// scripts/probe-auth-rate-limits.js — sends failing attempts and
// watches for the status to change. Spends your project's rate-limit
// budget from this machine's IP, so run it from CI, not your laptop.
for (let i = 1; i <= 20; i += 1) {
  const res = await fetch(`${base}/factors/${FAKE}/verify`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: FAKE, code: '000000' }),
  })
  if (res.status === 429) { console.log(`rate limited at attempt ${i}`); break }
  await new Promise((r) => setTimeout(r, 400))
}
```

> **One warning from our own mistake.** The first version of this script stalled
> after five requests and then printed *"NOT rate limited within 20 attempts"* —
> a false statement, and exactly the kind that gets copied into a handover
> document as if it were a measurement. Make an incomplete run report
> **inconclusive**, never negative.

### What an application limiter can honestly do

`supabase.auth.mfa.verify()` runs **in the browser** and talks to the auth server
directly. Your code is not in that path. So your limiter **cannot prevent an
attempt** — someone scripting the public API skips it entirely.

What it does is refuse to let *your app's* flow continue, durably, across
reloads. That raises the cost of attacking through the app. Say exactly that in
your own documentation and do not overclaim.

### The server must own the verdict

The first version of this limiter took the outcome from the client:

```js
// DO NOT DO THIS
const { kind, succeeded } = await req.json()
await admin.from('mfa_attempt').insert({ user_id, kind, succeeded })
```

An adversarial review took about ten minutes to break it. Since a
success inside the window clears every failure before it, one request
from a session holding **nothing but the password** resets the lockout:

```
POST /api/mfa-attempt   Authorization: Bearer <aal1 token>
{"kind":"totp","succeeded":true}     -> 200, counter cleared, guess again
```

The attacker never sends a failure, so the threshold is never reached,
and the attempt table ends up recording only successes. The route's own
comments argued that a counter in the browser is a counter the attacker
owns, and then took the counted value from the browser.

Derive the outcome from something the caller cannot forge — the access
token the auth server minted. A correct code produces a **new** token,
elevated to aal2 with a fresh `mfa/*` entry in `amr`; a wrong code
leaves the old one untouched:

```js
export function observedSuccess(claims, { now = Date.now(), windowSec = 120 } = {}) {
  // An aal1 caller has demonstrably not passed a second factor,
  // whatever its request body says.
  if (!claims || claims.aal !== 'aal2') return false

  // And an mfa/* method stamped within the last couple of minutes,
  // which is what separates "just verified" from "verified an hour
  // ago and is now adding a second device from Account settings".
  const amr = Array.isArray(claims.amr) ? claims.amr : []
  let sawTimestamp = false
  for (const e of amr) {
    if (typeof e === 'string') continue
    const ts = Number(e?.timestamp)
    if (!Number.isFinite(ts)) continue
    sawTimestamp = true
    if (String(e?.method || '').toLowerCase().startsWith('mfa/') && (now / 1000) - ts <= windowSec) return true
  }
  return !sawTimestamp     // no timestamps to read: fall back to aal alone
}
```

Validate the token with `getUser()` first; only then are its claims the
auth server's word rather than the caller's.

### Scope the lock, or it becomes a weapon

The same endpoint, pointed the other way. Scoped only by `user_id`,
anyone holding the password can spray five failures and lock the **real
owner** out of their own account from any browser. And since the
owner's documented escape is a password reset, which clears their
factors (§11), the denial of service is a lever that coerces the victim
into removing the protection the attacker could not defeat. Twenty
requests an hour.

Scope the per-caller count to the requester's hashed IP, and keep a
second, much higher cap account-wide so an attacker rotating addresses
still runs into something:

```js
const recent = ipHash ? all.filter((r) => r.ip_hash === ipHash) : all
// ...and separately, over every source and NOT cleared by a success
// elsewhere - a success on the owner's laptop must not hand an
// attacker twenty fresh guesses:
if (all.filter((r) => !r.succeeded).length >= MAX_ATTEMPTS_ALL_SOURCES) { /* locked */ }
```

### Where the count lives

Not in React state — a reload sets it to zero and the attacker owns the reload.
Not in memory on the server either: serverless instances come and go, each with
its own empty memory, so an in-process counter counts to one forever.

```sql
create table if not exists mfa_attempt (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  kind text not null,            -- 'totp' | 'reauth', counted separately
  succeeded boolean not null,    -- successes too, see below
  ip_hash text,                  -- SHA-256, salted. Never the address.
  created_at timestamptz not null default now()
);
create index if not exists mfa_attempt_user_idx
  on mfa_attempt(user_id, kind, created_at desc);

-- RLS ON with NO policies: service-role only. This reads like a
-- mistake and is the point. A client that can edit its own attempt
-- history can erase its own lockout, which is the whole control.
alter table mfa_attempt enable row level security;
```

### A lockout is a denial of service you build on purpose

The person most likely to trip it is the real owner, with a phone whose clock has
drifted. Every rule below follows from that:

```js
export const MAX_ATTEMPTS = 5
export const WINDOW_MS = 15 * 60 * 1000

export function attemptVerdict(rows, { now = Date.now() } = {}) {
  const cutoff = now - WINDOW_MS
  const recent = (rows || [])
    .filter((r) => r && Number.isFinite(new Date(r.created_at).getTime()))
    .filter((r) => new Date(r.created_at).getTime() > cutoff)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // A SUCCESS CLEARS THE COUNT. Without this, "four wrong, then the
  // real user got in, then one more typo" locks out an account that
  // has just proved itself. This is also why successes are recorded
  // and not only failures: a limiter that sees only failures cannot
  // tell those two situations apart.
  const lastSuccess = recent.find((r) => r.succeeded)
  const from = lastSuccess ? new Date(lastSuccess.created_at).getTime() : cutoff
  const failures = recent.filter((r) => !r.succeeded && new Date(r.created_at).getTime() > from)

  if (failures.length < MAX_ATTEMPTS) {
    return { allowed: true, remaining: MAX_ATTEMPTS - failures.length, retryAfterMs: 0 }
  }

  // THE LOCK ENDS A WINDOW AFTER THE OLDEST COUNTED FAILURE, not the
  // newest. Measuring from the newest is the obvious implementation
  // and lets an attacker who keeps trying hold the lock open forever —
  // punishing only the owner, who is the one waiting for it to end.
  const oldest = failures[failures.length - 1]
  const endsAt = new Date(oldest.created_at).getTime() + WINDOW_MS
  return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, endsAt - now) }
}
```

Three more rules:

- **Check before the code is sent, not only after.** A lockout that only appears
  once you have guessed again is not a lockout.
- **Always say when the wait ends.** "Try again later" gives someone no way to
  tell a lockout from a broken app — and with no backup codes, a confused owner's
  next move is a password reset, which costs them their 2FA setup.
- **Fail open.** If the table is unreachable the worst case is more guesses at a
  six-digit code. Failing closed turns one database hiccup into every 2FA account
  being locked out of your app: likelier, and far worse.

---

## 13. Remember this browser

### It does not make the session aal2

This is the part people get wrong. Supabase will not mint an `aal2` token without
a code, so there is **no way** to make a remembered browser genuinely fully
authenticated. What the cookie does is tell *your own gate* (§10) that this
browser passed a code recently enough to be let through at `aal1`.

It follows that **the cookie is as good as a second factor** for everything your
app protects, and must be treated that way.

```sql
create table if not exists mfa_trusted_device (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  token_hash text not null,      -- SHA-256 only. Never the token.
  label text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz not null
);
alter table mfa_trusted_device enable row level security;  -- no policies
```

The rules, each of which is load-bearing:

- **The browser holds a random secret; the database holds only its SHA-256.** A
  stolen dump is a pile of hashes, not working skip-2FA tokens.
- **Match on `token_hash` AND `user_id` in one query.** "Find the row, then check
  who it belongs to" is the shape this bug usually takes. Leave nothing to check
  afterwards.
- **Read expiry from the row, not the cookie's `Max-Age`.** A cookie's lifetime
  is a suggestion the browser makes to itself, and anyone can edit it.
- **Minting requires `aal2`.** Refuse an `aal1` caller. A route that turns "I
  know the password" into "I never need the code again" is worse than no second
  factor, because the user would believe they had one.
- **Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.** Lax rather than
  Strict — Strict withholds the cookie on a top-level navigation in from an
  external link, and the user is challenged despite having ticked the box.
- **Everything fails closed.** A false negative costs one extra code. A false
  positive means the second factor stops existing for whoever holds the cookie.

```js
// In the middleware, checked ONLY when the user would otherwise be
// bounced — so the common path costs nothing.
async function browserIsTrusted(request, userId) {
  const secret = request.cookies.get(TRUST_COOKIE)?.value
  if (!secret) return false
  try {
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY)
    const tokenHash = createHash('sha256').update(secret).digest('hex')
    const { data, error } = await admin
      .from('mfa_trusted_device')
      .select('id, user_id, expires_at')
      .eq('token_hash', tokenHash)
      .eq('user_id', userId)          // both, in one query
      .limit(1).maybeSingle()
    if (error || !data) return false
    return new Date(data.expires_at).getTime() > Date.now()
  } catch {
    return false
  }
}
```

### Give them a way to see and undo it

**This is the other half of the feature, not a nicety.** Granting a 30-day skip
from a login checkbox with no way to see or revoke it means a browser ticked once
on a shared machine keeps working for a month with the owner unable to find out.

List them in Account settings with a "Forget" per row and a "Forget all". Word
the bulk action for the situation someone is actually in when they reach for it:

> Every browser, including this one, will be asked for a code at the next
> sign-in. Do this if a device has been lost or stolen.

### Say "browser", not "device"

The trust follows a cookie. A phone has several browsers, and "device" promises
something the cookie cannot deliver — the user finds out when the other browser
asks for a code anyway.

---

# Part III — Make it good

## 14. Styling

The code above works and looks like a developer built it. This section is the
difference.

Everything here uses CSS custom properties — `--panel`, `--text`, `--muted`,
`--accent`, `--line`, `--loss`, `--be` (a warning amber), `--win` — so it adapts
to light and dark without a second set of rules. Substitute your own.

### 14.1 The QR code wrapper — the one that really matters

This is the single most important rule in the whole feature:

```css
.mfa-qr-wrap {
  background: #fff;          /* NOT var(--panel) */
  padding: 16px;
  border-radius: 10px;
  width: fit-content;
  margin: 10px 0;
}
.mfa-qr-wrap svg,
.mfa-qr-wrap img { display: block; width: 160px; height: 160px; }
```

**`background: #fff` is hardcoded on purpose, and it is not a dark-mode bug.**
A QR code is black modules on white. Drop it onto a dark panel and the white
becomes transparent or inverts, and phone cameras **cannot read it**. The user
sees a QR code that looks perfectly fine and simply will not scan, and will
assume your app is broken. It is a white card in both themes, always.

`padding: 16px` is the quiet zone the QR spec requires — scanners need clear
space around the pattern. `width: fit-content` stops the white card stretching
across the panel, which looks like a rendering error.

`display: block` on the image matters too: inline images sit on the text
baseline and leave a few pixels of white below, so the card looks subtly
off-centre and nobody can say why.

### 14.2 The manual-entry secret

Some users cannot scan — a broken camera, or they are setting up on the same
device they are reading on. Show the secret as text, always.

```css
.mfa-secret-row { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
.mfa-secret-row .del { display: flex; align-items: center; gap: 4px; }
```

Render the secret in a **monospace** face. `I`/`l`/`1` and `O`/`0` are the whole
problem with a hand-typed secret, and a monospace face with distinguishable
glyphs is the only fix.

### 14.3 The copy button

```css
/* The copy control reuses the delete-link class for its layout, which
   carries a RED hover — red on a control that destroys nothing. This
   restores a neutral hover without disturbing the shared class, which
   a dozen real delete links still use. */
.del.mfa-copy:hover { color: var(--accent); }
```

A small thing that is worth the two lines: **swap the icon for a tick and the
word for "copied" for about two seconds.** Clipboard writes are silent, and
without feedback people click three times and wonder.

```jsx
<span className="del mfa-copy" onClick={handleCopy}>
  {copied
    ? <><Check size={12} style={{ verticalAlign: '-2px' }} /> copied</>
    : <><Copy size={12} style={{ verticalAlign: '-2px' }} /> copy</>}
</span>
```

### 14.4 Inline SVG icons collapse to nothing

If your icons come from `lucide-react` or similar, **give every one an explicit
size in CSS**, not just a `size` prop:

```css
.mfa-factor-icon svg { width: 15px; height: 15px; }
```

Without it they render at 0px wide in some layouts and you get a mysterious gap.

### 14.5 The device list

```css
.mfa-factor-list { list-style: none; margin: 14px 0 0; padding: 0;
                   display: flex; flex-direction: column; gap: 2px; }
.mfa-factor-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 10px;
  background: var(--panel-2); border: 1px solid var(--line);
}
.mfa-factor-name {
  flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Icon-only, so it needs the global button rules reset: no accent
   pill, no radius, no shadow, no hover lift. The accessible name comes
   from aria-label, since there is no text to read. */
.mfa-factor-remove {
  background: none; border: none; box-shadow: none; border-radius: 8px;
  padding: 6px; color: var(--muted); cursor: pointer; flex: none;
  display: flex; align-items: center;
  transition: color .15s ease, background-color .15s ease;
}
.mfa-factor-remove:hover {
  color: var(--loss); background: rgba(225, 92, 92, .1);
  transform: none; filter: none; box-shadow: none;
}
```

`min-width: 0` on the flexible cell is what makes `text-overflow: ellipsis`
work inside a flex row. Without it a long device name pushes the delete button
off the edge instead of truncating.

### 14.6 The reset-password warning

Styled as a **caution, not an error**. Nothing has gone wrong, and a red panel
on a page someone reached because they are already locked out reads as a failure
they caused.

```css
.reset-2fa-warning {
  margin: 4px 0 14px; padding: 13px 14px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--be) 45%, transparent);
  background: color-mix(in srgb, var(--be) 9%, transparent);
  text-align: left;
}
.reset-2fa-warning-title {
  display: flex; align-items: center; gap: 7px;
  font-size: 13px; font-weight: 650; color: var(--be);
}
```

Amber at 9% opacity over the card rather than a solid fill, so the form below
stays the thing being looked at.

### 14.7 The "remember this browser" checkbox

```css
.mfa-trust-row {
  display: flex; align-items: center; gap: 9px;
  margin: 2px 0 14px; font-size: 12.5px; color: var(--muted);
  cursor: pointer; text-align: left;
  /* This is a <label>, and form styling usually uppercases those —
     right for a one-word field name, shouting for a sentence. Ours
     rendered as DON'T ASK FOR A CODE ON THIS BROWSER FOR 30 DAYS at
     someone mid-login until this was added. */
  text-transform: none; letter-spacing: normal; font-weight: 400;
}
.mfa-trust-row input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
```

Styled **quietly on purpose.** It offers to skip the second factor for a month,
so it should read as an option somebody takes deliberately — not as the obvious
next click sitting directly above the Verify button, competing with it.

Wrap the whole thing in the `<label>` so the text is tappable, not just the
15px box.

### 14.8 Two things that will catch you

**Stacked `<span>`s need `display: block`.** A name and a note inside a flex row
will render as `Mac (macOS)Won't ask for a code for 28 more days` on one line
until you say otherwise. Ours did.

**One column below ~520px.** Any grid of codes or identifiers must collapse on a
phone. Side by side, a string wraps mid-value, and a half-wrapped credential is
worse than a scrolled list — it is the kind of thing people transcribe wrong.

---

## 15. Words

The code can be perfect and still lose someone at the first screen. Assume the
reader does not know what an authenticator is.

### 15.1 The link everyone forgets

**Put "Lost your phone?" on the code entry screen.** Link it to your password
reset.

This is the most important sentence in this guide, and we shipped the feature
without it. A usability reviewer dumped the rendered code screen and found
**zero links on the page** — "Forgot password?" lives on the password step and
is removed at exactly the point it becomes the thing the user needs. A user who cannot produce a
code is looking at a form they cannot fill in. If nothing on that screen tells
them what to do, they will email you — or just stop using the app. The recovery
path you built in §11 is invisible unless you say it is there, at the exact
moment it is needed.

And do not label it "Forgot password?", because **he has not forgotten his
password.** He knows it perfectly. He has lost his phone. Those are different
problems in his head, and nothing connects them unless you do:

> **Lost or replaced your phone?**
> You can still get in. We'll email you a link to set a new password, and that
> switches off the code requirement so you can sign in.
> **[ Email me a link to get back in ]**

### 15.2 Jargon, and what to say instead

| Don't | Do |
|---|---|
| "Enrol a factor" | "Set up two-factor authentication" |
| "Authenticator" (alone) | "Your authenticator app" — and name two: "Google Authenticator, Authy, 1Password" |
| "Verify" | "Verify & enable" — say what happens |
| "Invalid TOTP code" | "Incorrect code — try again" |
| "AAL2 required" | Never show this to a user |
| "Revoke all trusted device tokens" | "Forget every browser" |
| "Device" (for a cookie) | "Browser" |

### 15.3 Say what the error probably is

"Incorrect code" is true and unhelpful. The commonest causes are a code that
aged out and a phone whose clock has drifted, and neither is something the user
would guess. When someone is running low on attempts, say so — being told "1
attempt left" is what makes a person stop and check their authenticator rather
than type the same stale code a third time.

### 15.4 Tell them the QR code is time-limited, and that codes rotate

"Scan this QR code with an authenticator app, then enter the 6-digit code it
shows." — good. Better: add that the code changes every 30 seconds, so a user
who types one slowly understands why it failed.

### 15.5 Name the consequence, not the mechanism

Confirmations should describe what happens to **them**:

> ✗ "This will unenroll your TOTP factor."
> ✓ "This is your only authenticator. Removing it turns two-factor
> authentication off, and makes your account easier to access if your password
> is ever compromised."

---

## 16. Accessibility

- **`autoComplete="one-time-code"`** on the code field. iOS and Android will
  offer the code from the clipboard or an SMS, and this one attribute removes a
  whole class of typing errors.
- **`inputMode="numeric"`** brings up the number pad. **`type="text"`**, not
  `type="number"` — see §2.
- **`maxLength={6}`** and `autoFocus` on the code step.
- **Label every icon-only button** with `aria-label`. A bare trash icon reads as
  "button" to a screen reader.
- **`aria-hidden="true"`** on decorative icons sitting beside text that already
  says the same thing.
- **Alt text on the QR image** (`alt="2FA QR code"`), plus the text secret as
  the real non-visual path — alt text cannot convey a QR code, so the secret is
  the accessible route, not a fallback.
- **Keyboard focus must be visible** on every control, including the ones you
  stripped `box-shadow` from in §14.5.
- **Don't rely on colour alone.** The expired row in the trusted-browser list is
  dimmed *and* says "Expired".

---

## 17. Testing it properly

### 17.1 Pure logic first

Everything in `lib/` above is a pure function taking data and returning a
decision. Test it directly — these tests found two real bugs for us:

```js
// The missing-claim default that was fail-open. Nothing but a test
// would have caught this.
it('fails closed on anything missing or malformed', () => {
  for (const bad of [null, {}, { amr: ['otp'] }]) {   // no aal claim
    expect(isRecoverySession(bad)).toBe(false)
  }
})

// Measuring the lock from the newest failure is the obvious
// implementation, and lets an attacker hold it open forever.
it('cannot be extended by hammering', () => {
  const base = [fail(14), fail(13), fail(12), fail(11), fail(10)]
  expect(verdict([...base, fail(0.5), fail(0.1)]).retryAfterMs)
    .toBe(verdict(base).retryAfterMs)
})
```

### 17.2 Make your mock reproduce *failures*

A mock that always succeeds will make a broken fix look verified. Ours
reproduces the refusals: `enroll()` rejects while an unverified factor exists,
`verify()` rejects wrong codes, unenrolling the last factor drops to aal1. That
way the workarounds in §7.1 are actually exercised rather than being dead code.

Two mock traps we hit, both of which made working features look broken:

- **A mock session with no `access_token`.** Any code path that posts the token
  to a server route silently never fires, and the page reports a failure. Give
  the mock a realistically-shaped JWT.
- **A route that authenticates for real.** In mock mode it refuses the fake
  token, prints a 401 in the console and renders an error. Give the component a
  mock branch.

### 17.3 Drive the real UI

Render it and click it. For each: both themes, and 390px as well as desktop.

- [ ] Enrol, cancel halfway, enrol again — the abandoned factor must not block it
- [ ] Enrol a second device with a duplicate name — rejected *before* the code
- [ ] Wrong code six times — lockout appears, says when it ends, survives a reload
- [ ] Correct code after a wrong one — the count clears
- [ ] Remove one of two devices — 2FA stays on, wording says so
- [ ] Remove the last device — different, stronger wording
- [ ] Log in with 2FA on, then with it off
- [ ] **Paste a recovery-link session into `/app` directly** — must be bounced
- [ ] Reset the password on an account with 2FA — warning shown, factors cleared
- [ ] Reset the password on an account *without* 2FA — no warning at all
- [ ] Tick "remember this browser", sign out, sign in — no code asked for
- [ ] "Forget all", sign out, sign in — code asked for again
- [ ] **No console errors anywhere**

### 17.4 Keep a regression fingerprint

Capture every auth screen as a text fingerprint plus console errors **before**
you start, and diff after each change. Ours caught a regression the eye missed:
four states had started logging 401s. A screenshot comparison would have passed.

---

## 18. Mistakes that cost us real time

1. **Enforcing 2FA only at the login form.** §10. The hole was real and had been
   open for months.
2. **Testing "has a factor" instead of the AAL comparison.** Locks you out of
   your own app with no way forward.
3. **Reading `factors[0]`.** Works with one device, silently wrong with two.
4. **Assuming the auth server rate-limits verification.** It did not. Measure.
5. **A diagnostic that reported a stalled run as a negative result.** It printed
   "not rate limited in 20 attempts" after managing five. That false line was one
   copy-paste from this document.
6. **Defaulting a missing `aal` claim to `aal1` in both directions.** Fail-closed
   in one function, fail-open in the other. §11.
7. **`type="number"` on the code field.** Eats leading zeros.
8. **A QR code on a dark background.** Looks fine, will not scan.
9. **Validating the device name after the code.** Reads as "wrong code" about a
   correct code.
10. **Clearing factors before changing the password.** An abandoned reset then
    silently strips someone's 2FA.
11. **Building passkeys without checking the server had the routes.** Five 404s.
    Twenty minutes of probing would have saved two days.
12. **Taking the verification outcome from the request body.** §12. The single
    worst bug in this whole build, and it was in the file whose own comments
    explained why not to.
13. **Scoping the lockout by user alone.** It became a way to force the victim
    into the flow that removes their 2FA.
14. **Leaving `/api/delete-account` on a bearer check.** Middleware covers
    pages; `/api` is not a page.
15. **Letting RLS keep `auth.uid() = user_id`.** 2FA protected the UI and not
    the data behind it.
16. **Shipping the code screen with no way out.** §15. It is written in this
    guide as the most important thing to do, and it was still missed.
17. **Checking the factor list before the claims.** `factors` is optional in
    auth-js's own type, so a missing field would have silently stopped
    enforcing 2FA everywhere. Absent is not empty.
18. **Forgetting the back button after sign-out.**

### Run a reviewer over it who did not build it

The last seven of those came from three reviewers pointed at the finished
work: one told to break the security, one told to be a 58-year-old who does
not know what an authenticator is, and one told to find regressions. They
found things the person who wrote the code could not, because the author
already believes the design.

Brief them to disagree. A review that comes back saying "looks solid" has
failed unless it also lists what it tried.

---

## 19. What is deliberately not here

- **SMS as a second factor.** SIM swapping is real and TOTP is strictly better.
- **Backup codes.** A deliberate product decision — §4. If your app holds money,
  make the other choice.
- **Passkeys / WebAuthn.** The client library supports them; our auth server
  (GoTrue v2.197.0) returns 404 on all five routes. Run the probe in §5 against
  yours before assuming either way.
- **Admin-forced 2FA.** Requiring it for all users is a policy decision with its
  own support burden.

---

## Quick reference

```js
// Enrol
const { data } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName })
// data.id, data.totp.qr_code, data.totp.secret

// Verify (enrolment or login — same two calls)
const { data: ch } = await supabase.auth.mfa.challenge({ factorId })
await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code })

// Is a code owed?
const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
const owed = aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2'

// List / remove
const { data } = await supabase.auth.mfa.listFactors()   // data.totp
await supabase.auth.mfa.unenroll({ factorId })           // needs aal2

// Server side (service role only)
await admin.auth.admin.mfa.listFactors({ userId })
await admin.auth.admin.mfa.deleteFactor({ userId, id })
```

**The six things to get right:**

1. Enforce assurance in middleware **and** in your API routes **and** in your
   row-level security — pages, endpoints, data. Missing any one of the three
   leaves the other two decorative.
2. Decide the lost-phone story before you build anything.
3. Never let the client report whether its own code was correct.
4. Measure what your auth server does; don't assume it.
5. Put "Lost your phone?" on the code screen, and don't call it
   "Forgot password?".
6. White background behind the QR code.

---

# Appendix A — The complete account-settings component

This is the real thing, lightly trimmed. It handles enrolment, the device list,
removal, and the two refusals from §7.1. Drop it into a Security panel.

```jsx
'use client'

import { useState } from 'react'
import { Copy, Check, Smartphone, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { useConfirm } from '@/lib/useConfirm'
import {
  verifiedFactors, unverifiedFactors, factorLabel,
  suggestFactorName, validateFactorName, isLastFactor,
} from '@/lib/mfaFactors'

export default function TwoFactorSection({ initialFactors }) {
  // The whole listFactors payload, not just the array: an unverified
  // factor must stay visible to the enrolment guard below.
  const [factorData, setFactorData] = useState(initialFactors || { totp: [] })
  const { confirm, modal: confirmModal } = useConfirm()
  const [enrolling, setEnrolling] = useState(false)
  const [enrollQr, setEnrollQr] = useState(null)
  const [enrollSecret, setEnrollSecret] = useState(null)
  const [enrollFactorId, setEnrollFactorId] = useState(null)
  const [deviceName, setDeviceName] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const factors = verifiedFactors(factorData)

  async function refresh() {
    const { data } = await supabase.auth.mfa.listFactors()
    setFactorData(data || { totp: [] })
    return data || { totp: [] }
  }

  async function handleEnroll() {
    setError('')
    setBusy(true)
    // Clear abandoned enrolments first, re-reading from the server
    // rather than trusting local state — another tab may have enrolled
    // since this page loaded, and the server is what enroll() is
    // judged by.
    const current = await refresh()
    for (const stale of unverifiedFactors(current)) {
      await supabase.auth.mfa.unenroll({ factorId: stale.id })
    }
    const fresh = await refresh()

    const friendlyName = suggestFactorName(fresh)
    const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName })
    setBusy(false)
    if (err) { setError("Couldn't start two-factor setup. Please try again."); return }

    setEnrollFactorId(data.id)
    setEnrollQr(data.totp.qr_code)
    setEnrollSecret(data.totp.secret)
    setDeviceName(friendlyName)
    setEnrolling(true)
  }

  async function handleVerify() {
    setError('')
    // Name BEFORE code: a collision is rejected by the server after a
    // correct code is accepted, which reads as "your code was wrong".
    const nameProblem = validateFactorName(deviceName, {
      totp: (factorData?.totp || []).filter((f) => f.id !== enrollFactorId),
    })
    if (nameProblem) { setError(nameProblem); return }
    if (!verifyCode.trim()) { setError('Enter the 6-digit code from your authenticator app.'); return }

    setBusy(true)
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId: enrollFactorId })
    if (chErr) { setError("Couldn't verify that code. Please try again."); setBusy(false); return }

    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId: enrollFactorId,
      challengeId: challenge.id,
      code: verifyCode.trim(),
    })
    setBusy(false)
    if (vErr) { setError('Incorrect code - try again.'); return }

    closeEnrolment()
    await refresh()
  }

  function closeEnrolment() {
    setEnrolling(false); setEnrollQr(null); setEnrollSecret(null)
    setEnrollFactorId(null); setVerifyCode(''); setDeviceName(''); setError('')
  }

  async function handleCancel() {
    if (enrollFactorId) await supabase.auth.mfa.unenroll({ factorId: enrollFactorId })
    closeEnrolment()
    await refresh()
  }

  async function handleRemove(factor) {
    const last = isLastFactor(factorData, factor.id)
    const sure = await confirm({
      title: last ? 'Turn Off Two-Factor Authentication' : `Remove ${factorLabel(factor)}`,
      message: last
        ? 'This is your only authenticator. Removing it turns two-factor authentication off, and makes your account easier to access if your password is ever compromised.'
        : `You will no longer be able to use ${factorLabel(factor)} to sign in. Your other authenticators keep working.`,
      confirmLabel: last ? 'Turn off 2FA' : 'Remove device',
      danger: true,
    })
    if (!sure) return
    setBusy(true)
    const { error: err } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
    setBusy(false)
    if (err) { setError("Couldn't remove that device. Please try again."); return }
    setError('')
    await refresh()
  }

  function handleCopy() {
    navigator.clipboard.writeText(enrollSecret)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <div className="panel-title">Two-factor authentication</div>

      {enrolling ? (
        <div className="mfa-enroll-block">
          <p className="onboard-note">
            Scan this QR code with an authenticator app (Google Authenticator,
            Authy, 1Password, etc.), then enter the 6-digit code it shows. The
            code changes every 30 seconds.
          </p>
          {enrollQr && (
            <div className="mfa-qr-wrap">
              {/* next/image is wrong here: this is a data: URI generated
                  at runtime, so there is no request to optimize — and
                  re-encoding a QR code can cost you a scan. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrollQr} alt="2FA QR code" />
            </div>
          )}
          <div className="mfa-secret-row">
            <span className="trade-id-cell">{enrollSecret}</span>
            <span className="del mfa-copy" onClick={handleCopy}>
              {copied
                ? <><Check size={12} style={{ verticalAlign: '-2px' }} /> copied</>
                : <><Copy size={12} style={{ verticalAlign: '-2px' }} /> copy</>}
            </span>
          </div>

          {/* Named at enrolment, not afterwards: with more than one
              authenticator the list is unreadable without names, and the
              moment the user is holding the device is the only moment
              they can say which one it is. */}
          <div className="field wide" style={{ marginTop: '14px' }}>
            <label>Device name</label>
            <input type="text" maxLength={60} value={deviceName}
                   onChange={(e) => setDeviceName(e.target.value)}
                   placeholder="Personal phone" />
          </div>
          <div className="field wide" style={{ marginTop: '14px' }}>
            <label>6-digit code</label>
            <input type="text" inputMode="numeric" autoComplete="one-time-code"
                   maxLength={6} value={verifyCode}
                   onChange={(e) => setVerifyCode(e.target.value)}
                   placeholder="123456" />
          </div>

          {error && <div className="account-msg account-msg-error">{error}</div>}
          <div className="submit-row" style={{ gap: '10px' }}>
            <button type="button" className="btn-danger-outline" onClick={handleCancel}>Cancel</button>
            <button type="button" onClick={handleVerify} disabled={busy}>
              {busy ? 'Verifying...' : 'Verify & enable'}
            </button>
          </div>
        </div>

      ) : factors.length > 0 ? (
        <>
          <div className="mfa-status-row">
            <div>
              <div className="mfa-status-enabled">Enabled</div>
              <div className="danger-row-note">
                {factors.length === 1
                  ? 'Your account requires a code from your authenticator app at login.'
                  : `Any of these ${factors.length} devices can provide your login code.`}
              </div>
            </div>
            <button onClick={handleEnroll} disabled={busy}>
              {busy ? 'Starting...' : 'Add device'}
            </button>
          </div>

          <ul className="mfa-factor-list">
            {factors.map((factor) => (
              <li className="mfa-factor-row" key={factor.id}>
                <span className="mfa-factor-icon" aria-hidden="true"><Smartphone size={15} /></span>
                <span className="mfa-factor-name">{factorLabel(factor)}</span>
                <button type="button" className="mfa-factor-remove"
                        onClick={() => handleRemove(factor)} disabled={busy}
                        aria-label={`Remove ${factorLabel(factor)}`}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>

      ) : (
        <div className="mfa-status-row">
          <div>
            <div className="danger-row-title">Not enabled</div>
            <div className="danger-row-note">Add an extra layer of security beyond your password.</div>
          </div>
          <button onClick={handleEnroll} disabled={busy}>
            {busy ? 'Starting...' : 'Set up 2FA'}
          </button>
        </div>
      )}

      {error && !enrolling && <div className="account-msg account-msg-error">{error}</div>}
      {confirmModal}
    </>
  )
}
```

### The three-state structure

The component is one `if / else if / else` over three states, and keeping it
that way is what stops it sprawling:

1. **Enrolling** — the QR code, the secret, the name, the code field
2. **Enabled** — the status line plus one row per device
3. **Not enabled** — a single row with the call to action

Load the initial factors in the parent page so the panel does not flash "Not
enabled" on every visit before the first fetch lands:

```js
const { data: mfaData } = await supabase.auth.mfa.listFactors()
// ...then <TwoFactorSection initialFactors={mfaData} />
```

---

# Appendix B — The supporting helpers

```js
// lib/mfaFactors.js
export function verifiedFactors(data) {
  return (data?.totp || []).filter((f) => f?.status === 'verified')
}

export function unverifiedFactors(data) {
  return (data?.totp || []).filter((f) => f && f.status !== 'verified')
}

export function factorLabel(factor) {
  if (factor?.friendly_name) return factor.friendly_name
  const when = factor?.created_at ? new Date(factor.created_at) : null
  return when ? `Authenticator added ${when.toLocaleDateString()}` : 'Authenticator'
}

// "Authenticator", then "Authenticator 2", and so on — so the default
// never collides with an existing name and trips the refusal in §7.1.
export function suggestFactorName(data, base = 'Authenticator') {
  const taken = new Set((data?.totp || []).map((f) => (f?.friendly_name || '').toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 100; n += 1) {
    if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
  }
  return `${base} ${Date.now()}`
}

export function validateFactorName(name, data) {
  const trimmed = (name || '').trim()
  if (!trimmed) return 'Give this device a name.'
  if (trimmed.length > 60) return 'That name is too long.'
  const taken = (data?.totp || []).some(
    (f) => (f?.friendly_name || '').toLowerCase() === trimmed.toLowerCase(),
  )
  if (taken) return 'You already have a device with that name.'
  return null
}

export function isLastFactor(data, factorId) {
  const verified = verifiedFactors(data)
  return verified.length === 1 && verified[0].id === factorId
}
```

---

*Written from a working implementation. Every claim about auth-server behaviour
in this document was measured against a live project on 2026-11-07 with the
scripts in §5 and §12 — re-run them against yours rather than trusting these
numbers, because they are facts about one project on one date, not guarantees.*
