// The token that proves a viewer context was minted by src/server/viewer.ts
// (ARCHITECTURE.md §3.1, INV-02). The import graph lets only viewer.ts and
// viewer.testing.ts import this module, so no other code can hold a value of
// `typeof MINT` to pass to a context constructor or `mint`.
export const MINT: unique symbol = Symbol("mint");
