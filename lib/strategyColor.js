// Deterministic color per strategy, based on its position in the list
// (ordered by creation date). Keeps the same strategy the same color
// everywhere in the app — sidebar, dashboard table, anywhere else.

const PALETTE = [
  '#BEE9E8',
  '#62B6CB',
  '#1B4965',
  '#CAE9FF',
  '#5FA8D3',
  '#A4DDED',
]

export function strategyColor(index) {
  return PALETTE[index % PALETTE.length]
}
