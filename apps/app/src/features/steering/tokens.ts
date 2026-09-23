// The token unit the steering assembler counts in, `ceil(utf8_bytes / 4)`
// (`budgetTokens` in @contextgraphprotocol/typescript-sdk, which
// packages/steering-assembler calls on every line it places). The Library's
// shelves count an item's cost with the same unit, over the same line, so a
// shelf and a run's steering manifest cannot disagree about it.
export function budgetTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}
