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

// Screen-capture tools default to PNG - often several megabytes for a
// single monitor, most of it spent losslessly preserving chart gridlines
// and axis text that a lossy re-encode barely affects visually. Downscaling
// to a sane max dimension and re-encoding as JPEG before upload cuts both
// the storage cost and the time every later view spends waiting on the
// file - see NOTES.md/the systems-map review this followed from. Runs
// entirely client-side via Canvas, no server or dependency involved.
const MAX_DIMENSION_PX = 1920
const JPEG_QUALITY = 0.82
// Below this, whatever compression would buy isn't worth the CPU time or
// the further quality loss - a file already this small was almost
// certainly already reasonably encoded (or is a small crop to begin with).
const SKIP_BELOW_BYTES = 300 * 1024

function withJpegExtension(name) {
  const dot = name.lastIndexOf('.')
  return (dot === -1 ? name : name.slice(0, dot)) + '.jpg'
}

// Small enough for an 80x80 grid tile to look sharp at typical device
// pixel ratios without hauling in the full (already-compressed) image just
// to shrink it with CSS. Lower quality than the full image is fine here -
// this size shows gridlines and colors, not text detail.
const THUMB_MAX_DIMENSION_PX = 240
const THUMB_JPEG_QUALITY = 0.7

// Same {basePath}.ext -> {basePath}-thumb.ext transform on both ends: this
// is how a full screenshot's path and its thumbnail's path relate, with no
// separate column needed to track the pairing (see the comment above
// getThumbnailUrls for why). A legacy full URL has no thumbnail of its own
// and is returned unchanged - getThumbnailUrls signs it as-is, same
// passthrough getScreenshotUrls already does.
function withThumbSuffix(path) {
  if (/^https?:\/\//.test(path)) return path
  const dot = path.lastIndexOf('.')
  return dot === -1 ? `${path}-thumb` : `${path.slice(0, dot)}-thumb${path.slice(dot)}`
}

// Best-effort - a failure here (missing browser support, a corrupt image)
// should never fail the trade save. getThumbnailUrls falls back to the
// full-size image for any path whose thumbnail object doesn't exist, so a
// screenshot with no thumbnail still displays correctly, just without the
// bandwidth saving.
async function makeThumbnail(file) {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, THUMB_MAX_DIMENSION_PX / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', THUMB_JPEG_QUALITY))
  } catch {
    return null
  }
}

// Downscales and re-encodes one picked file - falls back to the original,
// untouched, whenever compression wouldn't help or can't be attempted:
// a non-image (shouldn't reach here, but the picker's accept filter isn't
// a guarantee), an animated GIF (re-encoding would flatten it to one
// frame), a file already under the skip threshold, a browser lacking
// createImageBitmap/canvas support, a corrupt image, or a "compressed"
// result that somehow came back larger than the original. A slightly
// larger upload is a far smaller problem than a blocked one, so every
// failure path here returns the original file rather than throwing.
async function compressScreenshot(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file
  if (file.size < SKIP_BELOW_BYTES) return file

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_DIMENSION_PX / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    if (!blob || blob.size >= file.size) return file

    return new File([blob], withJpegExtension(file.name), { type: 'image/jpeg' })
  } catch {
    return file
  }
}

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
//
// Each screenshot also gets a small thumbnail uploaded alongside it, at
// withThumbSuffix(filePath) - not tracked in any column of its own
// (trades.screenshot_urls keeps storing only the full path, unchanged), so
// every consumer derives the thumbnail's path from the full one instead of
// the data model growing a {full, thumb} shape everywhere it's read. The
// thumbnail upload runs concurrently with the full one (both only need the
// already-compressed file) and is best-effort - a failed thumbnail upload
// doesn't fail the trade save, since getThumbnailUrls falls back to the
// full image whenever a thumbnail object doesn't exist.
export async function uploadScreenshots(screenshots) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  return Promise.all(screenshots.map(async (shot) => {
    const uploadable = await compressScreenshot(shot.file)
    const fileExt = uploadable.name.split('.').pop()
    const filePath = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`

    const [fullResult] = await Promise.all([
      supabase.storage.from('screenshots').upload(filePath, uploadable),
      makeThumbnail(uploadable).then((blob) => (
        blob ? supabase.storage.from('screenshots').upload(withThumbSuffix(filePath), blob) : null
      )),
    ])
    if (fullResult.error) throw fullResult.error

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

// The grid/list-view counterpart to getScreenshotUrls above - resolves
// each path's *thumbnail* object instead of the full image, for exactly
// the views that only ever render an 80x80 tile (the trade log's expand
// row, the trade detail page's grid, the edit form's existing-screenshot
// previews). Falls back to the full-size signed URL for any path whose
// thumbnail object doesn't exist - a screenshot uploaded before
// uploadScreenshots started generating one, or a rare thumbnail-upload
// failure at save time - so a missing thumbnail degrades to "loads the
// full image," never to a broken tile.
export async function getThumbnailUrls(paths) {
  if (!paths || paths.length === 0) return []

  const thumbPaths = paths.map(withThumbSuffix)
  const resolved = await getScreenshotUrls(thumbPaths)

  const missing = resolved.reduce((acc, url, i) => (url === null ? [...acc, i] : acc), [])
  if (missing.length === 0) return resolved

  const fallbacks = await getScreenshotUrls(missing.map((i) => paths[i]))
  missing.forEach((i, j) => { resolved[i] = fallbacks[j] })
  return resolved
}
