import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'

function parseDevice(ua) {
  const isIphone = /iPhone/.test(ua)
  const isIpad = /iPad/.test(ua)
  const isAndroid = /Android/.test(ua)
  const isMac = /Macintosh/.test(ua)
  const isWindows = /Windows/.test(ua)
  const isLinux = /Linux/.test(ua) && !isAndroid && !isIphone && !isIpad

  let os = 'Unknown OS'
  if (isIphone || isIpad) os = 'iOS'
  else if (isAndroid) os = 'Android'
  else if (isMac) os = 'macOS'
  else if (isWindows) os = 'Windows'
  else if (isLinux) os = 'Linux'

  let device = 'Device'
  if (isIphone) device = 'iPhone'
  else if (isIpad) device = 'iPad'
  else if (isAndroid) device = 'Android device'
  else if (isMac) device = 'Mac'
  else if (isWindows) device = 'Windows PC'
  else if (isLinux) device = 'Linux PC'

  let browser = 'browser'
  if (/Edg\//.test(ua)) browser = 'edge'
  else if (/OPR\//.test(ua)) browser = 'opera'
  else if (/Chrome\//.test(ua)) browser = 'chrome'
  else if (/Firefox\//.test(ua)) browser = 'firefox'
  else if (/Safari\//.test(ua)) browser = 'safari'

  return {
    label: `${device} (${os})`,
    key: `${device}-${browser}`.toLowerCase().replace(/\s+/g, '-'),
    }
  }

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
    return new Response(JSON.stringify({ error: upsertError.message }), { status: 500 })
    }

  return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
