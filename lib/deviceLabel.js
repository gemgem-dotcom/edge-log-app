// Turning a User-Agent string into something a person recognises.
//
// MOVED HERE UNCHANGED from app/api/record-login/route.js, which had
// been its only caller. The trusted-device list needs exactly the same
// labels - "iPhone (iOS)" beside "Mac (macOS)" - and two copies of this
// would drift the moment one of them learned about a new browser,
// leaving the two lists on the account page disagreeing about the same
// device. The logic is deliberately untouched by the move; its tests
// pin the current answers so a later tidy-up cannot quietly change
// what an existing login_events row means.
//
// The ordering of the checks is load-bearing and easy to break:
// Linux is tested last and excludes Android/iOS because those report
// Linux too, and Chrome is tested after Edge and Opera because both of
// those also say "Chrome/" in their User-Agent.
export function parseDevice(ua) {
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
