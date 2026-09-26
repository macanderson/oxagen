// update_runtime (ADR-204, #4372): rename a runtime or change whether it
// requires the contained launcher.
//
// The role gate is proven with a tx double, the way runtime.create.test.ts
// proves its own. The writes and the security event are proven against a
// real Postgres; that block runs where DATABASE_URL is set (CI's `test` job):
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/runtime.update.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  gate: {
    enabled: false,
    principalId: null as string | null,
    roleName: null as string | null,
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// When `mocks.gate.enabled`, withTenantDb answers the role gate's selects,
// answers every other select with no row, and throws on a write, so a call
// that passes the gate stops at the runtime read with `not_found`.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const gateTx = () => ({
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === real.schema.principals
            ? mocks.gate.principalId
              ? [{ id: mocks.gate.principalId }]
              : []
            : table === real.schema.principalRoleAssignments
              ? mocks.gate.roleName
                ? [{ roleName: mocks.gate.roleName }]
                : []
              : [];
        const chain = {
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          // The runtime read locks its row with `.for("update")` after
          // `.limit(1)`, so the limit answers a promise that also has `for`.
          limit: () =>
            Object.assign(Promise.resolve(rows), {
              for: async () => rows,
            }),
        };
        return chain;
      },
    }),
    insert: () => {
      throw new Error("a write reached the store");
    },
    update: () => {
      throw new Error("a write reached the store");
    },
  });
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      mocks.gate.enabled ? fn(gateTx()) : real.withTenantDb(fn as never),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { runtimeUpdateHandler } from "./runtime.update";
import { runtimeUpdate } from "@oxagen/oxagen/contracts/runtime.update";
import { makeCTX } from "./test-utils/fixtures";

const refused =
  (code: string, reason: string) =>
  (err: unknown): boolean =>
    isHandlerError(err) && err.code === code && err.reason === reason;

const UNKNOWN_RUNTIME = "rtm_0123456789abcdefghjkmn";

describe("update_runtime: the role gate", () => {
  beforeEach(() => {
    mocks.gate.enabled = true;
    mocks.gate.principalId = "prn_row";
    mocks.gate.roleName = null;
  });

  for (const role of ["Member", "Viewer", "Billing"]) {
    it(`refuses an org ${role}`, async () => {
      mocks.gate.roleName = role;
      await expect(
        runtimeUpdateHandler(
          { runtimeId: UNKNOWN_RUNTIME, containmentRequired: true },
          makeCTX(),
        ),
      ).rejects.toSatisfy(refused("forbidden", "org_role_required"));
    });
  }

  it("refuses a caller with no org role", async () => {
    await expect(
      runtimeUpdateHandler(
        { runtimeId: UNKNOWN_RUNTIME, containmentRequired: true },
        makeCTX(),
      ),
    ).rejects.toSatisfy(refused("forbidden", "org_role_required"));
  });

  for (const role of ["Owner", "Admin"]) {
    it(`lets an org ${role} past the gate to the runtime read`, async () => {
      mocks.gate.roleName = role;
      await expect(
        runtimeUpdateHandler(
          { runtimeId: UNKNOWN_RUNTIME, containmentRequired: true },
          makeCTX(),
        ),
      ).rejects.toSatisfy(refused("not_found", "runtime_not_found"));
    });
  }
});

describe.skipIf(!process.env.DATABASE_URL)(
  "update_runtime against Postgres",
  async () => {
    const { withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { and, eq } = await import("drizzle-orm");
    const support = await import(
      "@oxagen/agent/handlers/_agent-identity.test-support"
    );

    type Tenant =
      import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    let tenant: Tenant;
    let other: Tenant;
    const orgIds: string[] = [];
    const userIds: string[] = [];
    const inScope = <T>(t: Tenant, fn: () => Promise<T>) =>
      runInTenantScope({ orgId: t.orgId, workspaceId: t.workspaceId }, fn);
    const update = (input: Parameters<typeof runtimeUpdateHandler>[0]) =>
      inScope(tenant, () =>
        runtimeUpdateHandler(input, support.ctxFor(tenant, tenant.userId)),
      );
    const containmentEvents = (runtimeId: string) =>
      withSystemDb((tx) =>
        tx
          .select({
            actorUserId: schema.securityEvents.actorUserId,
            eventType: schema.securityEvents.eventType,
            detail: schema.securityEvents.detail,
          })
          .from(schema.securityEvents)
          .where(
            and(
              eq(schema.securityEvents.orgId, tenant.orgId),
              eq(schema.securityEvents.capability, "update_runtime"),
            ),
          ),
      ).then((rows) =>
        rows.filter(
          (r) =>
            (r.detail as { runtimeId?: string } | null)?.runtimeId ===
            runtimeId,
        ),
      );
    const storedContainment = async (publicId: string) => {
      const [row] = await withSystemDb((tx) =>
        tx
          .select({
            name: schema.runtimes.name,
            slug: schema.runtimes.slug,
            containmentRequired: schema.runtimes.containmentRequired,
          })
          .from(schema.runtimes)
          .where(eq(schema.runtimes.publicId, publicId)),
      );
      return row;
    };

    beforeAll(async () => {
      mocks.gate.enabled = false;
      tenant = await support.seedTenant("free");
      other = await support.seedTenant("free");
      orgIds.push(tenant.orgId, other.orgId);
      userIds.push(tenant.userId, other.userId);
      await support.seedMember(tenant, "Owner");
    });

    afterAll(async () => {
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    it("turns containment on and off, and records each change with the value before", async () => {
      const runtime = await support.seedRuntime(tenant, {
        name: "Build box",
        slug: "build-box",
      });

      const on = await update({
        runtimeId: runtime.publicId,
        containmentRequired: true,
      });
      expect(runtimeUpdate.output.parse(on)).toEqual({
        runtime: { id: runtime.publicId, name: "Build box", slug: "build-box" },
        containmentRequired: true,
      });
      expect((await storedContainment(runtime.publicId))?.containmentRequired)
        .toBe(true);

      const off = await update({
        runtimeId: runtime.publicId,
        containmentRequired: false,
      });
      expect(off.containmentRequired).toBe(false);

      const events = await containmentEvents(runtime.publicId);
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.detail)).toEqual(
        expect.arrayContaining([
          {
            feature: "runtime_containment",
            change: "containment_required",
            runtimeId: runtime.publicId,
            previous: false,
            enabled: true,
            reason: null,
          },
          {
            feature: "runtime_containment",
            change: "containment_required",
            runtimeId: runtime.publicId,
            previous: true,
            enabled: false,
            reason: null,
          },
        ]),
      );
      for (const event of events) {
        expect(event.eventType).toBe("capability.invoke_allowed");
        expect(event.actorUserId).toBe(tenant.userId);
      }
    });

    it("writes no event when containment does not change", async () => {
      const runtime = await support.seedRuntime(tenant, {
        name: "Quiet box",
        slug: "quiet-box",
        containmentRequired: true,
      });
      const same = await update({
        runtimeId: runtime.publicId,
        containmentRequired: true,
      });
      expect(same.containmentRequired).toBe(true);
      const untouched = await update({ runtimeId: runtime.publicId });
      expect(untouched.containmentRequired).toBe(true);
      expect(await containmentEvents(runtime.publicId)).toEqual([]);
    });

    it("renames the runtime, keeps its slug and its containment", async () => {
      const runtime = await support.seedRuntime(tenant, {
        name: "GPU box",
        slug: "gpu-box",
        containmentRequired: true,
      });
      const out = await update({
        runtimeId: runtime.publicId,
        name: "GPU box 2",
      });
      expect(out).toEqual({
        runtime: { id: runtime.publicId, name: "GPU box 2", slug: "gpu-box" },
        containmentRequired: true,
      });
      expect(await storedContainment(runtime.publicId)).toEqual({
        name: "GPU box 2",
        slug: "gpu-box",
        containmentRequired: true,
      });
      expect(await containmentEvents(runtime.publicId)).toEqual([]);
    });

    it("refuses an unknown runtime and one in another workspace", async () => {
      await expect(
        update({ runtimeId: UNKNOWN_RUNTIME, containmentRequired: true }),
      ).rejects.toSatisfy(refused("not_found", "runtime_not_found"));

      const foreign = await support.seedRuntime(other, {
        name: "Their box",
        slug: "their-box",
      });
      await expect(
        update({ runtimeId: foreign.publicId, containmentRequired: true }),
      ).rejects.toSatisfy(refused("not_found", "runtime_not_found"));
      expect((await storedContainment(foreign.publicId))?.containmentRequired)
        .toBe(false);
    });
  },
);
