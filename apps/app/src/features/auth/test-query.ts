// Test support: run a Drizzle relational query's `where` and `orderBy` callbacks
// against stand-in columns and operators, so a mocked `findFirst`/`findMany`
// still proves the filter a live query would send (and names every column).
type Options = { where?: unknown; orderBy?: unknown };

const columns = new Proxy({}, { get: (_t, name) => `col:${String(name)}` });
const operators = new Proxy(
  {},
  {
    get:
      (_t, op) =>
      (...args: unknown[]) =>
        `${String(op)}(${args.map((a) => (Array.isArray(a) ? `[${a.join(",")}]` : String(a))).join(",")})`,
  },
);

/** The filter and order a relational query options object describes, as readable strings. */
export function describeQuery(options: Options | undefined): {
  where?: string;
  orderBy?: string;
} {
  const out: { where?: string; orderBy?: string } = {};
  if (typeof options?.where === "function")
    out.where = String(
      (options.where as (c: unknown, o: unknown) => unknown)(
        columns,
        operators,
      ),
    );
  if (typeof options?.orderBy === "function")
    out.orderBy = String(
      (options.orderBy as (c: unknown, o: unknown) => unknown)(
        columns,
        operators,
      ),
    );
  return out;
}
