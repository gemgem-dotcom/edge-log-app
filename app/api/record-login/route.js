import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { parseDevice } from '@/lib/deviceLabel'
import { serviceRouteNeedsSecondFactor } from '@/lib/authAssurance'
import {
  readDeviceId, mintDeviceId, deviceIdCookie,
} from '@/lib/deviceIdentity'

export async function POST(req) {
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '').trim()

  if (!token) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })
    }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: userData, error: userError } = await admin.auth.getUser(token)

  if (userError || !userData || !userData.user) {
    return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 })
    }

  const userId = userData.user.id

  // The assurance gate, same as the other service-role routes - this
  // one writes the sign-in history the user reads as a security log,
  // and an aal1 caller could otherwise plant entries in it.
  //
  // Note it naturally permits the legitimate case: a session that has
  // no verified factor is not owed one, which is exactly what a normal
  // sign-in on a password-only account looks like. A 2FA account
  // records its sign-in after the code, when the token is aal2.
  if (await serviceRouteNeedsSecondFactor(admin, userId, token)) {
    return new Response(JSON.stringify({ error: 'Not fully authenticated' }), { status: 403 })
  }

  const ua = req.headers.get('user-agent') || ''
  const { label: deviceLabel, key: deviceKey } = parseDevice(ua)

  const forwardedFor = req.headers.get('x-forwarded-for') || ''
  const ip = forwardedFor.split(',')[0].trim() || req.headers.get('x-real-ip') || 'Unknown'

  const cityRaw = req.headers.get('x-vercel-ip-city') || ''
  const region = req.headers.get('x-vercel-ip-country-region') || ''
  const country = req.headers.get('x-vercel-ip-country') || ''
  const city = cityRaw ? decodeURIComponent(cityRaw) : ''
  const location = [city, region, country].filter(Boolean).slice(0, 2).join(', ') || 'Unknown location'

  // WHICH BROWSER IS THIS. Not which KIND of browser - see
  // lib/deviceIdentity.js for why that distinction cost this list its
  // whole purpose.
  const existingDeviceId = readDeviceId(req.headers.get('cookie'))
  const deviceId = existingDeviceId || mintDeviceId()
  const row = {
    user_id: userId,
    device: deviceLabel,
    device_key: deviceKey,
    device_id: deviceId,
    user_agent: ua,
    ip_address: ip,
    location,
    created_at: new Date().toISOString(),
  }

  let writeError = null

  if (existingDeviceId) {
    // A browser we have seen. One row per browser, its timestamp,
    // address and location refreshed.
    const { error } = await admin
      .from('login_events')
      .upsert(row, { onConflict: 'user_id,device_id' })
    writeError = error
  } else {
    // A browser we have NOT seen. It gets its own row - never merged
    // into an existing one, because merging on anything weaker than
    // this id is the bug.
    //
    // ADOPTION, ONCE. Rows written before this existed have device_id
    // null, and the user has named some of them. Without this, the
    // first sign-in after deploy would leave "gemma's pc" orphaned and
    // create an unnamed duplicate beside it. So a brand-new id claims
    // at most ONE unclaimed row of the same device_key.
    //
    // This is the old ambiguity, deliberately, for exactly one sign-in
    // per device class: if the work laptop signs in before the home PC
    // does, it inherits the home PC's nickname. The cost is a wrong
    // label the user can correct; the alternative is every named device
    // silently losing its name. After that one adoption the two
    // diverge properly and never merge again.
    const { data: adoptable } = await admin
      .from('login_events')
      .select('id')
      .eq('user_id', userId)
      .eq('device_key', deviceKey)
      .is('device_id', null)
      .order('created_at', { ascending: false })
      .limit(1)

    if (adoptable && adoptable.length) {
      const { error } = await admin
        .from('login_events')
        .update(row)
        .eq('id', adoptable[0].id)
      writeError = error
    } else {
      const { error } = await admin.from('login_events').insert(row)
      writeError = error
    }
  }

  if (writeError) {
    Sentry.captureException(writeError)
    // A fixed string, not writeError.message. Raw Postgres error text
    // told the client about the schema and was the one route in this
    // set that did; the detail is in Sentry where it is useful.
    return new Response(JSON.stringify({ error: 'Could not record this sign-in.' }), { status: 500 })
  }

  const headers = { 'Content-Type': 'application/json' }
  if (!existingDeviceId) {
    headers['Set-Cookie'] = deviceIdCookie(deviceId, {
      secure: process.env.NODE_ENV === 'production',
    })
  }

  return new Response(JSON.stringify({ success: true }), { status: 200, headers })
  }
