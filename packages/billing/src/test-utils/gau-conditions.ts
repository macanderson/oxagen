/**
 * The plain condition objects a GAU test's `drizzle-orm` mock builds in place
 * of `eq`, `lt`, `lte`, `isNull`, `and` and `desc`, and that
 * `test-utils/gau-fake-tx.ts` evaluates. Kept import-free so a `vi.mock`
 * factory can load it while `drizzle-orm` itself is still being mocked.
 */

export type Cond =
  | { op: "eq" | "lt" | "lte"; col: unknown; val: unknown }
  | { op: "isNull"; col: unknown }
  | { op: "and"; conds: Cond[] };

export const conditionMocks = {
  eq: (col: unknown, val: unknown): Cond => ({ op: "eq", col, val }),
  lt: (col: unknown, val: unknown): Cond => ({ op: "lt", col, val }),
  lte: (col: unknown, val: unknown): Cond => ({ op: "lte", col, val }),
  isNull: (col: unknown): Cond => ({ op: "isNull", col }),
  and: (...conds: Cond[]): Cond => ({ op: "and", conds }),
  desc: (col: unknown) => ({ _desc: col }),
};
