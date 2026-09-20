// `noUncheckedIndexedAccess` is on (tsconfig.base.json), so indexing a query's
// result gives `T | undefined` and a test that wants the third row has to say
// what it does when there is no third row. The repo's answer is an explicit
// throw rather than a non-null assertion, which the app's ESLint config
// forbids everywhere including tests.
//
// This is that throw, once, with the element named so a failure reads as
// "expected a 3rd row in the budgets table" rather than as a type error three
// lines later.

/** The element at `index`, or a failure that names what was missing. */
export function nth<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined)
    throw new Error(
      `expected ${what} at index ${String(index)}, found ${String(items.length)}`,
    );
  return item;
}
