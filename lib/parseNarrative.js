// Turns Claude's insight text into renderable blocks - deliberately not a
// general Markdown parser (no react-markdown/remark dependency to pull
// in): the prompt (app/api/generate-insights/route.js) fully controls the
// output shape - plain paragraphs, plus GitHub-flavored-markdown tables
// (a header row, a `---` separator row, body rows) where Claude judges a
// table is warranted - so a small parser matched exactly to that
// contract is all this needs. Blocks are separated by a blank line, same
// convention as ordinary Markdown paragraphs.

function isTableBlock(lines) {
  return lines.length >= 2 && lines.every((l) => l.trim().startsWith('|')) && /^\|[\s:|-]+\|$/.test(lines[1].trim())
}

function splitRow(line) {
  // Drop the leading/trailing empty cells a `| a | b |`-style row produces
  // when split on `|`.
  const cells = line.trim().split('|').map((c) => c.trim())
  return cells.slice(1, -1)
}

function parseTable(lines) {
  return { type: 'table', headers: splitRow(lines[0]), rows: lines.slice(2).map(splitRow) }
}

// Returns an array of { type: 'paragraph', text } | { type: 'table', headers, rows }.
export function parseNarrativeBlocks(text) {
  if (!text) return []
  const blocks = text.trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  return blocks.map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    return isTableBlock(lines) ? parseTable(lines) : { type: 'paragraph', text: block.replace(/\n/g, ' ') }
  })
}
