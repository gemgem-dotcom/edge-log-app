import { randomBytes } from 'crypto'

// Telling one browser from another in the sign-in history.
//
// WHAT WAS WRONG. `login_events` was upserted on `(user_id, device_key)`,
// and device_key comes from lib/deviceLabel.js as
// `${deviceClass}-${browser}` - "windows-pc-chrome", "mac-chrome". That
// is a device CLASS, not a device. Every Windows machine running Chrome
// produced the same key, so a second Windows laptop did not appear in
// the list at all: it overwrote the first one's row, taking its
// timestamp, IP and location with it.
//
// That is a real reporting failure, not a cosmetic one. The panel says
// "If you don't recognise any of these devices, we recommend logging out
// of all devices and changing your password." An attacker signing in
// from Windows + Chrome - the single most common combination there is -
// would silently overwrite the owner's own row instead of appearing as a
// new one. The one list whose entire job is to reveal an unrecognised
// sign-in could not reveal the likeliest one.
//
// WHAT THIS IS INSTEAD. A random per-browser id in a long-lived cookie,
// minted the first time a browser records a sign-in. It identifies a
// browser, which is the thing the list is actually trying to show.
//
// IT IS A LABEL, NOT A CREDENTIAL. Nothing is authorised by it and no
// gate reads it. Forging one lets you relabel your own history row and
// nothing else, which is why it is not hashed the way the trusted-device
// token is (see lib/trustedDevice.js, where the value really is a
// credential and the database stores only its SHA-256). Keep it that
// way: the moment anything trusts this cookie, it needs that treatment.

export const DEVICE_ID_COOKIE = 'edgelog_did'

// Long, because a browser that silently becomes a "new device" every few
// months fills the list with duplicates of itself and trains the owner to
// ignore entries they do not recognise - the exact instinct this panel
// depends on.
export const DEVICE_ID_MAX_AGE_SEC = 2 * 365 * 24 * 60 * 60

const ID_BYTES = 16
const ID_PATTERN = /^[0-9a-f]{32}$/

export function mintDeviceId() {
  return randomBytes(ID_BYTES).toString('hex')
}

// Validated on the way in. The value reaches a unique index and a
// `device_nickname` the user reads, so anything that is not the shape we
// mint is treated as absent rather than stored.
export function readDeviceId(cookieHeader) {
  const raw = String(cookieHeader || '')
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== DEVICE_ID_COOKIE) continue
    const value = rest.join('=').trim()
    return ID_PATTERN.test(value) ? value : null
  }
  return null
}

export function deviceIdCookie(value, { secure = true } = {}) {
  return [
    `${DEVICE_ID_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${DEVICE_ID_MAX_AGE_SEC}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ')
}
