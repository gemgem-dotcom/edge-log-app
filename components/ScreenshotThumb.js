'use client'

// One trade screenshot thumbnail, or its skeleton while the URL resolves.
//
// Extracted so the desktop table and the mobile trade list render the
// same tile from one place rather than two copies that can drift. It also
// keeps the `<img>` to a single site: these are private Supabase signed
// URLs, which next/image cannot optimise without remotePatterns config,
// so the plain <img> is deliberate - and this repo's lint gate is a
// ratchet on the warning count, which a second copy would have raised.
//
// `url` null means "not resolved yet", which is a different thing from
// "no screenshot" - the caller decides whether there is a tile at all.
export default function ScreenshotThumb({ url, index, size = 70, className = '', onOpen }) {
  const style = { width: `${size}px`, height: `${size}px` }
  if (!url) return <div className={`skel skel-thumb ${className}`.trim()} style={style} />
  return (
    <img
      src={url}
      alt={`Trade screenshot ${index + 1}`}
      className={`thumb ${className}`.trim()}
      style={style}
      onClick={(e) => { e.stopPropagation(); onOpen?.(index) }}
    />
  )
}
