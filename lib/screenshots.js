import { supabase } from './supabaseClient'

// Uploads the newly picked screenshots and returns their public URLs.
// Throws on the first failure so the caller can surface its own message —
// the two trade pages word that differently. Uploads run concurrently
// (Promise.all over map, not a sequential loop) so N screenshots take
// roughly as long as one instead of N times as long - Promise.all still
// rejects with the first error to reject, same throw-on-first-failure
// behavior the sequential loop had, so callers need no changes.
export async function uploadScreenshots(screenshots) {
  return Promise.all(screenshots.map(async (shot) => {
    const fileExt = shot.file.name.split('.').pop()
    const filePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`
    const { error } = await supabase.storage.from('screenshots').upload(filePath, shot.file)
    if (error) throw error
    const { data } = supabase.storage.from('screenshots').getPublicUrl(filePath)
    return data.publicUrl
  }))
}
