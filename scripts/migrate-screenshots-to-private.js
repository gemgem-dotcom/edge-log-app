#!/usr/bin/env node
// One-time: migrate existing trade screenshots from the old flat, public
// bucket layout ({timestamp}-{random}.ext, a permanent public URL stored
// in trades.screenshot_urls) to the new private, per-user layout
// ({user_id}/{timestamp}-{random}.ext, a storage path only - see
// storage-setup.sql and lib/screenshots.js). Uses the service role key,
// which bypasses storage RLS entirely, so this can run before or after
// storage-setup.sql flips the bucket to private and adds the per-user
// policies - the data migration itself doesn't depend on that ordering,
// only the actual privacy guarantee does (a screenshot isn't really
// isolated until both this script and that SQL have run).
//
// For each trade with a screenshot still stored as a full public URL:
// downloads the existing object, re-uploads it under the trade's own
// owner's new {user_id}/... path, and only after confirming the new copy
// is actually readable does it (a) update trades.screenshot_urls/
// screenshot_url to the new path - not a URL, since the app now resolves
// a fresh signed URL at render time (lib/screenshots.js's
// getScreenshotUrls) - and (b) delete the old object. Never deletes
// before verifying the new copy exists and is readable. Safe to re-run:
// a trade whose screenshots are already stored as paths (not full URLs)
// is left untouched.
//
// Usage: node scripts/migrate-screenshots-to-private.js
// Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function isLegacyUrl(value) {
  return /^https?:\/\//.test(value)
}

// A public Supabase Storage URL is {SUPABASE_URL}/storage/v1/object/
// public/{bucket}/{path} - the {path} suffix is the object's actual
// identity within the bucket, and the only way this script locates an
// existing screenshot without guessing.
function objectPathFromPublicUrl(url, supabaseUrl) {
  const marker = `${supabaseUrl}/storage/v1/object/public/screenshots/`
  if (!url.startsWith(marker)) return null
  return decodeURIComponent(url.slice(marker.length))
}

async function migrateTrade(admin, trade, supabaseUrl) {
  const shots = trade.screenshot_urls?.length ? trade.screenshot_urls : (trade.screenshot_url ? [trade.screenshot_url] : [])
  if (!shots.some(isLegacyUrl)) return { skipped: true }

  const newPaths = []
  const oldPaths = []
  for (const value of shots) {
    if (!isLegacyUrl(value)) { newPaths.push(value); continue } // already migrated

    const oldPath = objectPathFromPublicUrl(value, supabaseUrl)
    if (!oldPath) throw new Error(`couldn't parse object path from ${value}`)

    const { data: fileData, error: downloadError } = await admin.storage.from('screenshots').download(oldPath)
    if (downloadError) throw new Error(`download failed for ${oldPath}: ${downloadError.message}`)

    const ext = oldPath.split('.').pop()
    const newPath = `${trade.user_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error: uploadError } = await admin.storage.from('screenshots').upload(newPath, fileData)
    if (uploadError) throw new Error(`upload failed for ${newPath}: ${uploadError.message}`)

    // Confirm the new copy is actually readable before doing anything
    // else with it - never delete the old object on the strength of
    // upload() reporting success alone.
    const { error: verifyError } = await admin.storage.from('screenshots').download(newPath)
    if (verifyError) throw new Error(`verify-read failed for ${newPath}: ${verifyError.message}`)

    newPaths.push(newPath)
    oldPaths.push(oldPath)
  }

  const { error: updateError } = await admin.from('trades').update({
    screenshot_urls: newPaths,
    screenshot_url: newPaths[0] || null,
  }).eq('id', trade.id)
  if (updateError) throw new Error(`failed to update screenshot_urls: ${updateError.message}`)

  if (oldPaths.length > 0) {
    const { error: removeError } = await admin.storage.from('screenshots').remove(oldPaths)
    if (removeError) {
      // The new copies are already verified and the trade row already
      // points at them - a failed cleanup just leaves an orphaned old
      // object behind, not a broken trade. Log it and move on rather
      // than failing the whole run over a delete that doesn't affect
      // correctness.
      log(`Trade ${trade.id}: new copies verified and trade row updated, but failed to delete old object(s): ${removeError.message}`)
    }
  }

  return { migrated: newPaths.length }
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: trades, error } = await admin.from('trades').select('id, user_id, screenshot_url, screenshot_urls')
  if (error) throw new Error(`Failed to load trades: ${error.message}`)

  const withScreenshots = (trades || []).filter((t) => (t.screenshot_urls?.length || t.screenshot_url))
  log(`${withScreenshots.length} trade(s) with at least one screenshot.`)

  let migrated = 0
  let skipped = 0
  let failed = 0
  for (const trade of withScreenshots) {
    try {
      const result = await migrateTrade(admin, trade, supabaseUrl)
      if (result.skipped) {
        skipped += 1
      } else {
        migrated += 1
        log(`Trade ${trade.id}: migrated ${result.migrated} screenshot(s).`)
      }
    } catch (err) {
      failed += 1
      log(`Trade ${trade.id}: FAILED - ${err.message}`)
    }
  }

  log(`Done. Migrated: ${migrated}. Already migrated (skipped): ${skipped}. Failed: ${failed}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
