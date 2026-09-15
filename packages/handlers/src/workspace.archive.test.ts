// archive_workspace: the role gate, the two refusals and the write.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tenant, db, emitted } = vi.hoisted(() => ({
  tenant: {
    principalId: "prn_1" as string | null,
    roleName: "Owner" as string | null,
  },
  db: {
    /** The workspace row the select answers, or none. */
    workspace: null as Record<string, unknown> | null,
    updates: [] as Array<Record<string, unknown>>,
  },
  emitted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const rowsFor = (table: unknown): unknown[] => {
    if (table === real.schema.principals)
      return tenant.principalId ? [{ id: tenant.principalId }] : [];
    if (table === real.schema.principalRoleAssignments)
      return tenant.roleName ? [{ roleName: tenant.roleName }] : [];
    if (table === real.schema.workspaces)
      return db.workspace ? [db.workspace] : [];
    throw new Error("unexpected table");
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => Promise.resolve(rowsFor(table)),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          db.updates.push(values);
        },
      }),
    }),
  };
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: vi.fn(async (e: Record<string, unknown>) => {
    emitted.push(e);
  }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { workspaceArchiveHandler } from "./workspace.archive";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-00000000000a",
  workspaceId: "00000000-0000-0000-0000-00000000000b",
  userId: "00000000-0000-0000-0000-00000000000c",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

const ACTIVE = {
  id: "ws-uuid",
  publicId: "wrk_core",
  slug: "core",
  name: "Core",
  archivedAt: null,
};

const run = (workspaceId = "wrk_core", c = ctx) =>
  workspaceArchiveHandler(workspaceArchive.input.parse({ workspaceId }), c);

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  if (!isHandlerError(err))
    throw new Error(`expected a HandlerError, got ${err}`);
  return { code: err.code, reason: err.reason };
};

beforeEach(() => {
  tenant.principalId = "prn_1";
  tenant.roleName = "Owner";
  db.workspace = { ...ACTIVE };
  db.updates.length = 0;
  emitted.length = 0;
});

describe("archive_workspace", () => {
  it("writes archived_at and archived_by together, answers with the row, and records the security event", async () => {
    const out = await run();
    expect(out).toMatchObject({ id: "wrk_core", slug: "core", name: "Core" });
    expect(workspaceArchive.output.safeParse(out).success).toBe(true);
    expect(db.updates).toHaveLength(1);
    const write = db.updates[0]!;
    expect(write.archivedAt).toBeInstanceOf(Date);
    expect(write.archivedByUserId).toBe(ctx.userId);
    expect(out.archivedAt).toBe((write.archivedAt as Date).toISOString());
    expect(emitted).toEqual([
      expect.objectContaining({
        eventType: "workspace.archived",
        actorUserId: ctx.userId,
        orgId: ctx.orgId,
        workspaceId: "ws-uuid",
        capability: "archive_workspace",
        outcome: "success",
      }),
    ]);
  });

  it("lets an org Admin archive", async () => {
    tenant.roleName = "Admin";
    await expect(run()).resolves.toMatchObject({ id: "wrk_core" });
  });

  it.each(["Member", "Billing", "Compliance", "Viewer"])(
    "refuses an org %s with forbidden / org_role_required and writes nothing (negative)",
    async (roleName) => {
      tenant.roleName = roleName;
      await expect(refusal(run())).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(db.updates).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    },
  );

  it("refuses a context with no user (negative)", async () => {
    await expect(
      refusal(run("wrk_core", { ...ctx, userId: null })),
    ).resolves.toEqual({ code: "forbidden", reason: "no_principal" });
  });

  it("refuses a workspace outside the org with not_found (negative)", async () => {
    db.workspace = null;
    await expect(refusal(run("wrk_elsewhere"))).resolves.toEqual({
      code: "not_found",
      reason: "workspace_not_found",
    });
    expect(db.updates).toHaveLength(0);
  });

  it("refuses a workspace already archived with conflict / already_archived (negative)", async () => {
    db.workspace = { ...ACTIVE, archivedAt: new Date("2026-09-01T00:00:00Z") };
    const err = await run().catch((e) => e);
    expect(isHandlerError(err) && err.code).toBe("conflict");
    expect(isHandlerError(err) && err.reason).toBe("already_archived");
    expect(String(err.message)).toContain("2026-09-01");
    expect(db.updates).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});
