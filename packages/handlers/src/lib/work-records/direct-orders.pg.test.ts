// Attaching a direct work order to a work item, against a real Postgres (F13,
// #4638). The attachment records its time from the database's clock, a second
// attachment to the same work item changes nothing, and the store refuses a
// direct work order or a work item outside the caller's workspace, a deleted
// work item, and a move to another work item.
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it. Every row it writes is
// removed in afterAll.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { isWorkRecordError } from "@oxagen/work/records";
import { eq } from "drizzle-orm";
import { attachDirectOrder } from "./direct-orders";
import type { WorkScope } from "./store";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled) throw new Error("The direct work order test needs DATABASE_URL on CI.");

describe.skipIf(!enabled)("attaching a direct work order against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const scope: WorkScope = { orgId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const other: WorkScope = { orgId: scope.orgId, workspaceId: crypto.randomUUID() };
  const AMARA = crypto.randomUUID();
  let counter = 0;

  const inScope = <T>(fn: (tx: Tx) => Promise<T>, s: WorkScope = scope): Promise<T> =>
    runInTenantScope(s, () => withTenantDb(fn));

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(schema.workDirectOrders).where(eq(schema.workDirectOrders.orgId, scope.orgId));
      await tx.delete(schema.workItems).where(eq(schema.workItems.orgId, scope.orgId));
    });
    await closeDatabase();
  });

  async function newItem(s: WorkScope = scope, deleted = false): Promise<string> {
    counter += 1;
    const n = counter;
    return inScope(async (tx) => {
      const [row] = await tx
        .insert(schema.workItems)
        .values({
          orgId: s.orgId,
          workspaceId: s.workspaceId,
          number: `F13-${tag}-${n}`,
          subject: "Fix invites",
          origin: "manual",
          ...(deleted ? { deletedAt: new Date() } : {}),
        })
        .returning({ id: schema.workItems.id });
      return row!.id;
    }, s);
  }

  /** A direct work order as the spend rollup opens one, for a run that started an hour ago. */
  async function newDirectOrder(s: WorkScope = scope): Promise<{ id: string; publicId: string; openedAt: Date }> {
    counter += 1;
    const [row] = await withSystemDb((tx) =>
      tx
        .insert(schema.workDirectOrders)
        .values({
          orgId: s.orgId,
          workspaceId: s.workspaceId,
          runId: `tse_f13${tag}${counter}`,
          openedAt: new Date(Date.now() - 60 * 60 * 1000),
        })
        .returning({
          id: schema.workDirectOrders.id,
          publicId: schema.workDirectOrders.publicId,
          openedAt: schema.workDirectOrders.openedAt,
        }),
    );
    return row!;
  }

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isWorkRecordError(error)) return error.code;
      throw error;
    }
    throw new Error("The store accepted the attachment.");
  }

  it("records the work item and the time it was attached", async () => {
    const order = await newDirectOrder();
    const item = await newItem();
    const before = Date.now();
    const attached = await inScope((tx) => attachDirectOrder(tx, scope, { directOrder: order.id, itemId: item, by: AMARA }));
    expect(attached).toMatchObject({
      directOrderId: order.id,
      publicId: order.publicId,
      itemId: item,
      attachedBy: AMARA,
      repeat: false,
    });
    expect(attached.attachedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(attached.attachedAt.getTime()).toBeGreaterThan(attached.openedAt.getTime());

    const [stored] = await inScope((tx) =>
      tx
        .select({
          itemId: schema.workDirectOrders.itemId,
          attachedAt: schema.workDirectOrders.attachedAt,
          attachedBy: schema.workDirectOrders.attachedBy,
        })
        .from(schema.workDirectOrders)
        .where(eq(schema.workDirectOrders.id, order.id)),
    );
    expect(stored).toEqual({ itemId: item, attachedAt: attached.attachedAt, attachedBy: AMARA });
  });

  it("finds a direct work order by its public id, and treats a second attachment to the same work item as a repeat", async () => {
    const order = await newDirectOrder();
    const item = await newItem();
    const first = await inScope((tx) =>
      attachDirectOrder(tx, scope, { directOrder: order.publicId, itemId: item, by: AMARA }),
    );
    const second = await inScope((tx) =>
      attachDirectOrder(tx, scope, { directOrder: order.publicId, itemId: item, by: crypto.randomUUID() }),
    );
    expect(second).toMatchObject({ repeat: true, itemId: item, attachedBy: AMARA });
    expect(second.attachedAt).toEqual(first.attachedAt);
  });

  it("refuses to move an attachment to another work item", async () => {
    const order = await newDirectOrder();
    const item = await newItem();
    await inScope((tx) => attachDirectOrder(tx, scope, { directOrder: order.id, itemId: item, by: AMARA }));
    const moved = await newItem();
    expect(
      await refusal(inScope((tx) => attachDirectOrder(tx, scope, { directOrder: order.id, itemId: moved, by: AMARA }))),
    ).toBe("not_allowed");
  });

  it("refuses a work item from another workspace, a deleted work item, and one that does not exist", async () => {
    const order = await newDirectOrder();
    const elsewhere = await newItem(other);
    const deleted = await newItem(scope, true);
    for (const itemId of [elsewhere, deleted, crypto.randomUUID(), "wi_not_a_uuid"]) {
      expect(
        await refusal(inScope((tx) => attachDirectOrder(tx, scope, { directOrder: order.id, itemId, by: AMARA }))),
      ).toBe("not_found");
    }
  });

  it("hides another workspace's direct work order", async () => {
    const order = await newDirectOrder(other);
    const item = await newItem();
    expect(
      await refusal(inScope((tx) => attachDirectOrder(tx, scope, { directOrder: order.id, itemId: item, by: AMARA }))),
    ).toBe("not_found");
  });

  it("names the person who attaches it", async () => {
    const order = await newDirectOrder();
    const item = await newItem();
    expect(
      await refusal(inScope((tx) => attachDirectOrder(tx, scope, { directOrder: order.id, itemId: item, by: " " }))),
    ).toBe("invalid_input");
  });
});
