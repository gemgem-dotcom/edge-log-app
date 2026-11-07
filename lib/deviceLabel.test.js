import { describe, it, expect } from 'vitest'
import { parseDevice } from './deviceLabel'

// These pin the answers parseDevice gave while it lived inside
// app/api/record-login/route.js. It was moved into lib/ so the trusted
// device list could share it, and a move is exactly when behaviour
// slips: the `key` is a stored column used as an upsert conflict
// target, so a changed answer silently splits one device's sign-in
// history into two rows.

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadSafari: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  linuxOpera: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
}

describe('parseDevice - labels', () => {
  it('names each platform the way the sign-in list already shows it', () => {
    expect(parseDevice(UA.iphoneSafari).label).toBe('iPhone (iOS)')
    expect(parseDevice(UA.ipadSafari).label).toBe('iPad (iOS)')
    expect(parseDevice(UA.androidChrome).label).toBe('Android device (Android)')
    expect(parseDevice(UA.macChrome).label).toBe('Mac (macOS)')
    expect(parseDevice(UA.winEdge).label).toBe('Windows PC (Windows)')
    expect(parseDevice(UA.linuxOpera).label).toBe('Linux PC (Linux)')
  })
  it('falls back rather than throwing on an unrecognised agent', () => {
    expect(parseDevice('').label).toBe('Device (Unknown OS)')
    expect(parseDevice('curl/8.4.0').label).toBe('Device (Unknown OS)')
  })
})

describe('parseDevice - the ordering that is easy to break', () => {
  // Android and iOS both say "Linux" or are built on it; Linux is
  // tested last and excludes them for that reason.
  it('does not call an Android phone a Linux PC', () => {
    expect(parseDevice(UA.androidChrome).label).toBe('Android device (Android)')
  })
  // Edge and Opera both carry "Chrome/" in their User-Agent, so they
  // have to be tested before Chrome or every one of them is "chrome".
  it('tells Edge and Opera apart from Chrome', () => {
    expect(parseDevice(UA.winEdge).key).toContain('edge')
    expect(parseDevice(UA.linuxOpera).key).toContain('opera')
    expect(parseDevice(UA.macChrome).key).toContain('chrome')
  })
  // Chrome's User-Agent also ends in "Safari/537.36".
  it('does not call Chrome Safari', () => {
    expect(parseDevice(UA.macChrome).key).not.toContain('safari')
    expect(parseDevice(UA.macSafari).key).toContain('safari')
  })
})

describe('parseDevice - the key', () => {
  // The key is an upsert conflict target on login_events. If it ever
  // changes shape, one device's history silently splits into two rows.
  it('is lowercase with no spaces', () => {
    for (const ua of Object.values(UA)) {
      const { key } = parseDevice(ua)
      expect(key).toBe(key.toLowerCase())
      expect(key).not.toMatch(/\s/)
    }
  })
  it('keeps the exact values already stored', () => {
    expect(parseDevice(UA.iphoneSafari).key).toBe('iphone-safari')
    expect(parseDevice(UA.macChrome).key).toBe('mac-chrome')
    expect(parseDevice(UA.winEdge).key).toBe('windows-pc-edge')
    expect(parseDevice(UA.winFirefox).key).toBe('windows-pc-firefox')
    expect(parseDevice(UA.androidChrome).key).toBe('android-device-chrome')
  })
  it('is stable for the same agent', () => {
    expect(parseDevice(UA.macChrome).key).toBe(parseDevice(UA.macChrome).key)
  })
})
