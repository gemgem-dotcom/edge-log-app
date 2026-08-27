import { supabase } from '@/lib/supabaseClient'

// The screenshots bucket is private (storage-setup.sql) - a stored value
// is a storage path within that bucket, never a directly usable URL, and
// generating a signed URL requires SELECT permission on the object, which
// the bucket's RLS policy scopes to the object's own path prefix matching
// the requesting user's auth.uid(). A screenshot is viewable only by the
// user who owns it, checked on every URL generation - never through a
// permanent or guessable link that works regardless of who's asking (see
// NOTES.md's "Uploaded files must be private and per-user" for the
// standing rule this follows).
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60

// A signed URL is reusable by anyone holding it until it actually expires
// (see NOTES.md's caveat on this), so there's no privacy cost to caching one
// in memory for reuse within this same browser session - it's exactly as
// shareable either way. This just avoids re-requesting a URL that's still
// perfectly valid every time a screenshot is re-viewed (collapsing and
// re-expanding a trade log row, navigating away from a trade detail page
// and back). Cleared implicitly on a full page reload, since this is a
// plain module-level Map, not persisted storage.
const urlCache = new Map()
// Stop treating a cached URL as valid a few minutes before its real expiry,
// so a screenshot that's mid-render never gets handed a URL that goes
// stale moments later.
const CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000

// Uploads the newly picked screenshots and returns their storage paths
// (not URLs - the bucket is private, so a URL would need to be freshly
// signed at view time anyway; see getScreenshotUrls). Nested under the
// uploading user's own id so the per-user RLS policy has something to
// scope against. Throws on the first failure so the caller can surface
// its own message — the two trade pages word that differently. Uploads
// run concurrently (Promise.all over map, not a sequential loop) so N
// screenshots take roughly as long as one instead of N times as long -
// Promise.all still rejects with the first error to reject, same
// throw-on-first-failure behavior a sequential loop has, so callers need
// no changes for that part.
export async function uploadScreenshots(screenshots) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  return Promise.all(screenshots.map(async (shot) => {
    const fileExt = shot.file.name.split('.').pop()
    const filePath = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`
    const { error } = await supabase.storage.from('screenshots').upload(filePath, shot.file)
    if (error) throw error
    return filePath
  }))
}

// Resolves stored screenshot identifiers into fresh, short-lived signed
// URLs for display - every render site (trade detail page, log table's
// expand row, the edit form's existing-screenshot previews) needs to call
// this instead of using a stored value directly, since a storage path was
// never a usable URL in the first place and a previously-signed URL goes
// stale after SIGNED_URL_EXPIRY_SECONDS. A path this account isn't
// entitled to read (not its own) fails the RLS check `createSignedUrl`
// itself enforces and comes back null here, same as any other resolution
// failure - never a fallback to a public/guessable link.
//
// A stored value that's still a legacy full URL (a trade whose screenshots
// predate scripts/migrate-screenshots-to-private.js, or hasn't been
// migrated yet) is passed through as-is rather than mis-signed - remove
// this branch once every trade has been confirmed migrated (see that
// script's own header comment).
export async function getScreenshotUrls(paths) {
  if (!paths || paths.length === 0) return []

  const now = Date.now()
  const results = new Array(paths.length)
  // Only the paths that need an actual signed-URL request - a legacy full
  // URL needs no signing, and a cache hit needs no network call at all.
  const toFetch = []

  paths.forEach((path, i) => {
    if (/^https?:\/\//.test(path)) { results[i] = path; return }
    const cached = urlCache.get(path)
    if (cached && cached.expiresAt > now) { results[i] = cached.url; return }
    toFetch.push({ path, index: i })
  })

  if (toFetch.length === 0) return results

  // One request for every path still needing a fresh URL, rather than a
  // separate createSignedUrl call per screenshot - a trade with several
  // screenshots no longer waits on N round-trips before any of them can
  // start loading.
  const { data, error } = await supabase.storage
    .from('screenshots')
    .createSignedUrls(toFetch.map((f) => f.path), SIGNED_URL_EXPIRY_SECONDS)

  if (error) {
    toFetch.forEach((f) => { results[f.index] = null })
    return results
  }

  const expiresAt = now + SIGNED_URL_EXPIRY_SECONDS * 1000 - CACHE_SAFETY_MARGIN_MS
  data.forEach((entry, i) => {
    const { path, index } = toFetch[i]
    if (entry.error || !entry.signedUrl) { results[index] = null; return }
    urlCache.set(path, { url: entry.signedUrl, expiresAt })
    results[index] = entry.signedUrl
  })

  return results
}
