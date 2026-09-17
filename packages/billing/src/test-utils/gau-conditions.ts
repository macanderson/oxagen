/**
 * The plain condition objects a GAU test's `drizzle-orm` mock builds in place
 * of `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull`, `and`, `asc` and `desc`, and that
 * `test-utils/gau-fake-tx.ts` evaluates. Kept import-free so a `vi.mock`
 * factory can load it while `drizzle-orm` itself is still being mocked.
 */

export type Cond =
  | {
      op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      col: unknown;
      val: unknown;
    }
  | { op: "isNull"; col: unknown }
  | { op: "and"; conds: Cond[] };

export const conditionMocks = {
  eq: (col: unknown, val: unknown): Cond => ({ op: "eq", col, val }),
  ne: (col: unknown, val: unknown): Cond => ({ op: "ne", col, val }),
  lt: (col: unknown, val: unknown): Cond => ({ op: "lt", col, val }),
  lte: (col: unknown, val: unknown): Cond => ({ op: "lte", col, val }),
  gt: (col: unknown, val: unknown): Cond => ({ op: "gt", col, val }),
  gte: (col: unknown, val: unknown): Cond => ({ op: "gte", col, val }),
  isNull: (col: unknown): Cond => ({ op: "isNull", col }),
  // drizzle's `and` skips an undefined condition; so does this one.
  and: (...conds: (Cond | undefined)[]): Cond => ({
    op: "and",
    conds: conds.filter((c): c is Cond => c !== undefined),
  }),
  asc: (col: unknown) => ({ _asc: col }),
  desc: (col: unknown) => ({ _desc: col }),
};
