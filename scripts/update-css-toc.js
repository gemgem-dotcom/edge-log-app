#!/usr/bin/env node

// Regenerates the TABLE OF CONTENTS block at the top of app/globals.css from
// the actual /* ---------- Section ---------- */ banners in the file, so
// nobody has to hand-recompute ~35 line numbers after every CSS edit.
//
// Usage:
//   node scripts/update-css-toc.js          rewrites the file in place
//   node scripts/update-css-toc.js --check  exits 1 if the ToC is stale,
//                                            without writing anything
//
// The ToC's own line count depends on how many banners exist, which the
// ToC itself sits above - inserting/removing a banner shifts every banner
// below it by the same amount the ToC's line count changed. Rather than
// special-case that, this computes the new ToC twice: once to measure its
// line count, then again with every banner number shifted by however much
// that count differs from the old ToC's, which is exact regardless of how
// many banners were added, removed, or renamed.

const fs = require('fs')
const path = require('path')

const CSS_PATH = path.join(__dirname, '..', 'app', 'globals.css')
const TOC_START = '   ------------------------------------------------------------'
const TOC_END = '   ============================================================ */'
const BANNER_RE = /^\/\* -{4,}\s*(.+?)\s*-{4,} \*\/$/
const BASE_LABEL = 'Base: reset, typography, forms, tables, thumbnails,'
const BASE_LABEL_CONT = '            modals, and the mobile breakpoints for all of them'

function findBanners(lines) {
  const banners = []
  lines.forEach((line, idx) => {
    const m = line.match(BANNER_RE)
    if (m) banners.push({ line: idx + 1, name: m[1] })
  })
  if (banners.length === 0) {
    throw new Error('No /* ---------- Section ---------- */ banners found in ' + CSS_PATH)
  }
  return banners
}

function buildTocLines(baseEnd, banners) {
  return [
    `     1–${baseEnd}  ${BASE_LABEL}`,
    BASE_LABEL_CONT,
    ...banners.map((b) => `   ${b.line}  ${b.name}`),
  ]
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const original = fs.readFileSync(CSS_PATH, 'utf8')
  const lines = original.split('\n')

  const startIdx = lines.findIndex((l) => l === TOC_START)
  const endIdx = lines.findIndex((l) => l === TOC_END)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Could not find the TABLE OF CONTENTS markers in ' + CSS_PATH)
  }
  const oldTocLineCount = endIdx - startIdx - 1

  // Pass 1: banner positions as they exist right now (accurate regardless
  // of whether the current ToC text is stale, since these come from the
  // real file, not from the ToC).
  const banners = findBanners(lines)
  const firstBannerLine = banners[0].line
  const provisionalToc = buildTocLines(firstBannerLine - 1, banners)

  // Pass 2: shift every banner by however many lines the ToC is about to
  // grow or shrink by, then rebuild with corrected numbers.
  const delta = provisionalToc.length - oldTocLineCount
  const shiftedBanners = banners.map((b) => ({ ...b, line: b.line + delta }))
  const finalToc = buildTocLines(firstBannerLine - 1 + delta, shiftedBanners)

  const newLines = [...lines.slice(0, startIdx + 1), ...finalToc, ...lines.slice(endIdx)]
  const updated = newLines.join('\n')

  if (updated === original) {
    console.log('CSS table of contents already up to date.')
    return
  }

  if (checkOnly) {
    console.error('CSS table of contents is stale - run `npm run css:toc` to fix it.')
    process.exit(1)
  }

  fs.writeFileSync(CSS_PATH, updated)
  console.log(`Updated CSS table of contents (${banners.length} sections).`)
}

main()
