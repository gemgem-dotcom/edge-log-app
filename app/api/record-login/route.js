import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { parseDevice } from '@/lib/deviceLabel'
import { serviceRouteNeedsSecondFactor } from '@/lib/authAssurance'

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

  const { error: upsertError } = await admin
  .from('login_events')
  .upsert(
    {
      user_id: userId,
      device: deviceLabel,
      device_key: deviceKey,
      user_agent: ua,
      ip_address: ip,
      location,
      created_at: new Date().toISOString(),
      },
    { onConflict: 'user_id,device_key' }
    )

  if (upsertError) {
    Sentry.captureException(upsertError)
    // A fixed string, not upsertError.message. Raw Postgres error text
    // told the client about the schema and was the one route in this
    // set that did; the detail is in Sentry where it is useful.
    return new Response(JSON.stringify({ error: 'Could not record this sign-in.' }), { status: 500 })
    }

  return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
