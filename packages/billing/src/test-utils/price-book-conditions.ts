/**
 * The plain condition objects a price-book test's `drizzle-orm` mock builds in
 * place of `eq`, `isNull`, `and` and `or`, and that
 * `test-utils/price-book-fake-tx.ts` evaluates. Kept import-free so a
 * `vi.mock` factory can load it while `drizzle-orm` itself is still being
 * mocked — the same reason `test-utils/gau-conditions.ts` is import-free.
 */

export type PriceCond =
  | { op: "eq"; col: unknown; val: unknown }
  | { op: "gt" | "lte"; col: unknown; val: Date }
  | { op: "inArray"; col: unknown; vals: unknown[] }
  | { op: "arrayOverlaps"; col: unknown; vals: unknown[] }
  | { op: "isNull"; col: unknown }
  | { op: "and"; conds: PriceCond[] }
  | { op: "or"; conds: PriceCond[] };

export const priceConditionMocks = {
  gt: (col: unknown, val: Date): PriceCond => ({ op: "gt", col, val }),
  lte: (col: unknown, val: Date): PriceCond => ({ op: "lte", col, val }),
  eq: (col: unknown, val: unknown): PriceCond => ({ op: "eq", col, val }),
  inArray: (col: unknown, vals: readonly unknown[]): PriceCond => ({
    op: "inArray",
    col,
    vals: [...vals],
  }),
  arrayOverlaps: (col: unknown, vals: readonly unknown[]): PriceCond => ({
    op: "arrayOverlaps",
    col,
    vals: [...vals],
  }),
  isNull: (col: unknown): PriceCond => ({ op: "isNull", col }),
  // drizzle's `and`/`or` skip an undefined condition; so do these.
  and: (...conds: (PriceCond | undefined)[]): PriceCond => ({
    op: "and",
    conds: conds.filter((c): c is PriceCond => c !== undefined),
  }),
  or: (...conds: (PriceCond | undefined)[]): PriceCond => ({
    op: "or",
    conds: conds.filter((c): c is PriceCond => c !== undefined),
  }),
};
