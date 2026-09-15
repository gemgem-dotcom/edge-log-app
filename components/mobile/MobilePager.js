'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

// Paging for the mobile lists.
//
// Kept as prev/next rather than made into infinite scroll, which was the
// obvious phone-native choice and is the wrong one here. The trade log is
// the surface a trader goes back through looking for a specific trade,
// and infinite scroll has no addressable position - you cannot say "it was
// near the end of page 2", you can only scroll again. Paging also keeps
// the DB-side pagination this page already does (lib/tradeQuery.js)
// working exactly as it does on desktop rather than needing an
// accumulating client-side buffer.
//
// Renders nothing at all when everything fits on one page, so the common
// case shows no chrome.
export default function MobilePager({ page, pageSize, totalCount, onPageChange }) {
  const pages = Math.max(1, Math.ceil((totalCount || 0) / pageSize))
  if (pages <= 1) return null

  const first = page * pageSize + 1
  const last = Math.min((page + 1) * pageSize, totalCount)

  return (
    <div className="m-pager">
      <button
        type="button"
        className="m-pager-btn"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 0}
        aria-label="Previous page"
      >
        <ChevronLeft size={18} />
      </button>

      {/* The range, not just the page number. "26-50 of 112" answers
          "how far in am I" in one glance; "2" does not. */}
      <span className="m-pager-label">{first}–{last} of {totalCount}</span>

      <button
        type="button"
        className="m-pager-btn"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= pages - 1}
        aria-label="Next page"
      >
        <ChevronRight size={18} />
      </button>
    </div>
  )
}
