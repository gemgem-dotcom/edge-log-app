import { readDeviceId, mintDeviceId, deviceIdCookie } from '@/lib/deviceIdentity'

// Establishes this browser's id BEFORE the sign-in flow needs it.
//
// WHY A ROUTE OF ITS OWN, when /api/record-login and /api/trusted-device
// both already read-or-mint the same cookie.
//
// Because both of those run at the END of a sign-in, and both are POSTs
// made from a page that is about to navigate away. If the Set-Cookie on
// either response is lost - the navigation beats it, the response is
// discarded, the browser is an embedded web view with its own jar - the
// id is never established, and the NEXT sign-in mints another one. That
// is exactly what the data showed: the same iPhone, same user agent,
// same address, with a different device_id eight hours later, and a
// third "trusted device" row for a browser that was already trusted
// twice.
//
// Called on login page mount, this runs while the user is still typing.
// The cookie is in place before anything depends on it, and every later
// request in the flow carries it.
//
// IT GRANTS NOTHING. No session is required and none is read: the id
// labels a browser, it does not authorise one. Issuing it to an
// anonymous visitor is the point - the browser needs a name before we
// know who is using it. Nothing is written to the database here.

export async function GET(req) {
  const existing = readDeviceId(req.headers.get('cookie'))
  const deviceId = existing || mintDeviceId()

  const headers = { 'Content-Type': 'application/json' }
  if (!existing) {
    headers['Set-Cookie'] = deviceIdCookie(deviceId, {
      secure: process.env.NODE_ENV === 'production',
    })
  }

  // The id is returned so the caller can tell "already known" from "just
  // issued" in its own logs. It is not a secret - the browser holding it
  // is the browser it names - but it is never needed by client code, so
  // the cookie stays httpOnly and this stays informational.
  return new Response(
    JSON.stringify({ known: Boolean(existing) }),
    { status: 200, headers },
  )
}
