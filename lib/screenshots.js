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
export async function uploadScreenshots(screenshots) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  return Promise.all(screenshots.map(async (shot) => {
    const uploadable = await compressScreenshot(shot.file)
    const fileExt = uploadable.name.split('.').pop()
    const filePath = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`
    const { error } = await supabase.storage.from('screenshots').upload(filePath, uploadable)
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
  return Promise.all(paths.map(async (path) => {
    if (/^https?:\/\//.test(path)) return path
    const { data, error } = await supabase.storage.from('screenshots').createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS)
    if (error) return null
    return data.signedUrl
  }))
}
