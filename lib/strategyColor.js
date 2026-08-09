// Deterministic color per strategy, based on its position in the list
// (ordered by creation date). Keeps the same strategy the same color
// everywhere in the app — sidebar, dashboard table, anywhere else.

const PALETTE = [
  '#79decd', // accent blue
  '#8b5cf6', // violet
  '#eab308', // amber
  '#e15c5c', // red
  '#2dd4bf', // teal
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
]

export function strategyColor(index) {
  return PALETTE[index % PALETTE.length]
}
