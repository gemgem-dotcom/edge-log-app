import { supabase } from './supabaseClient'

// Uploads the newly picked screenshots and returns their public URLs.
// Throws on the first failure so the caller can surface its own message —
// the two trade pages word that differently.
export async function uploadScreenshots(screenshots) {
  const urls = []
  for (const shot of screenshots) {
    const fileExt = shot.file.name.split('.').pop()
    const filePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fileExt}`
    const { error } = await supabase.storage.from('screenshots').upload(filePath, shot.file)
    if (error) throw error
    const { data } = supabase.storage.from('screenshots').getPublicUrl(filePath)
    urls.push(data.publicUrl)
  }
  return urls
}
