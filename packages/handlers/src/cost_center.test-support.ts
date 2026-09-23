// cost_center.test-support.ts — the Drizzle double the cost-center handler
// suites share (ADR-142). Not a handler and not a test.
//
// Each `select()` chain resolves at its terminal call (`limit`, `orderBy` or
// `groupBy`) with the next entry of `selects`, in the order the handler reads.
// Each `update()` chain records the table and the `.set()` values, and
// resolves `returning()` with the next entry of `updates`. Each `insert()`
// records its values and returns them as the stored row. The double imports
// nothing from vitest, so this file stays plain source.
export type TxDouble = ReturnType<typeof makeTx>;

export function makeTx(
  opts: { selects?: unknown[][]; updates?: unknown[][] } = {},
) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];
  const calls = {
    selects: 0,
    updates: [] as { table: unknown; values: Record<string, unknown> }[],
    inserts: [] as Record<string, unknown>[],
  };
  const nextSelect = async () => selects.shift() ?? [];
  const selectChain = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: nextSelect,
      orderBy: nextSelect,
      groupBy: nextSelect,
    };
    return chain;
  };
  const tx = {
    select: () => {
      calls.selects += 1;
      return selectChain();
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        calls.updates.push({ table, values });
        return {
          where: () => ({
            returning: async () => updates.shift() ?? [],
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        calls.inserts.push(values);
        return {
          returning: async () => [
            {
              id: "row-new",
              publicId: "ccn_new",
              createdAt: new Date("2026-09-22T12:00:00.000Z"),
              deletedAt: null,
              ...values,
            },
          ],
        };
      },
    }),
  };
  return { tx, calls };
}

/** A `cost.cost_centers` row as Drizzle returns it. */
export function centerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    publicId: "ccn_1",
    orgId: "org_1",
    label: "ENG-1001",
    description: "Platform engineering",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    createdById: "u_0",
    updatedById: "u_0",
    deletedAt: null as Date | null,
    deletedById: null as string | null,
    ...overrides,
  };
}
