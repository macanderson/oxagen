// create_runtime and list_runtimes (ADR-192, #4369), and the runtime a host
// enrollment binds.
//
// The role gate is proven with a tx double, the way agent.identity.test.ts
// proves its own. The writes and reads are proven against a real Postgres;
// that block runs where DATABASE_URL is set (CI's `test` job):
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/runtime.create.test.ts
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
// that passes the gate stops at its first insert.
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
          limit: async () => rows,
        };
        return chain;
      },
    }),
    insert: () => {
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

import { runtimeCreateHandler } from "./runtime.create";
import { runtimeListHandler } from "./runtime.list";
import { runtimeCreate } from "@oxagen/oxagen/contracts/runtime.create";
import { runtimeList } from "@oxagen/oxagen/contracts/runtime.list";
import { makeCTX } from "./test-utils/fixtures";

const refused =
  (code: string, reason: string) =>
  (err: unknown): boolean =>
    isHandlerError(err) && err.code === code && err.reason === reason;

describe("create_runtime: the role gate and the slug", () => {
  beforeEach(() => {
    mocks.gate.enabled = true;
    mocks.gate.principalId = "prn_row";
    mocks.gate.roleName = null;
  });

  for (const role of ["Member", "Viewer", "Billing"]) {
    it(`refuses an org ${role}`, async () => {
      mocks.gate.roleName = role;
      await expect(
        runtimeCreateHandler({ name: "Build box" }, makeCTX()),
      ).rejects.toSatisfy(refused("forbidden", "org_role_required"));
    });
  }

  it("lets an org Admin past the gate to the insert", async () => {
    mocks.gate.roleName = "Admin";
    await expect(
      runtimeCreateHandler({ name: "Build box" }, makeCTX()),
    ).rejects.toThrow(/a write reached the store/);
  });

  it("refuses a name with no letter or digit to make a slug from", async () => {
    mocks.gate.roleName = "Owner";
    await expect(
      runtimeCreateHandler({ name: "'&!" }, makeCTX()),
    ).rejects.toSatisfy(refused("conflict", "runtime_slug_empty"));
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "runtimes against Postgres",
  async () => {
    const { withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq } = await import("drizzle-orm");
    const support = await import(
      "@oxagen/agent/handlers/_agent-identity.test-support"
    );
    const { findOrCreateHostRuntime } = await import("./lib/runtimes");

    let tenant: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    const orgIds: string[] = [];
    const userIds: string[] = [];
    const inScope = <T>(fn: () => Promise<T>) =>
      runInTenantScope(
        { orgId: tenant.orgId, workspaceId: tenant.workspaceId },
        fn,
      );
    const ctx = () => support.ctxFor(tenant, tenant.userId);

    beforeAll(async () => {
      mocks.gate.enabled = false;
      tenant = await support.seedTenant("free");
      orgIds.push(tenant.orgId);
      userIds.push(tenant.userId);
      await support.seedMember(tenant, "Owner");
    });

    afterAll(async () => {
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    it("create_runtime derives the slug from the name, dropping the apostrophe", async () => {
      const out = await inScope(() =>
        runtimeCreateHandler({ name: "Mac's Laptop" }, ctx()),
      );
      expect(runtimeCreate.output.parse(out)).toEqual(out);
      expect(out.runtime).toMatchObject({
        name: "Mac's Laptop",
        slug: "macs-laptop",
      });
    });

    it("create_runtime refuses a slug another live runtime holds, and takes a typed one", async () => {
      await expect(
        inScope(() => runtimeCreateHandler({ name: "Macs laptop" }, ctx())),
      ).rejects.toSatisfy(refused("conflict", "runtime_slug_taken"));
      const typed = await inScope(() =>
        runtimeCreateHandler(
          { name: "Macs laptop", slug: "macs-laptop-2" },
          ctx(),
        ),
      );
      expect(typed.runtime.slug).toBe("macs-laptop-2");
    });

    it("list_runtimes names each runtime's live agents and host enrollments", async () => {
      const created = await inScope(() =>
        runtimeCreateHandler({ name: "GPU box" }, ctx()),
      );
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ id: schema.runtimes.id })
          .from(schema.runtimes)
          .where(eq(schema.runtimes.publicId, created.runtime.id)),
      );
      const agent = await support.seedAgent(tenant, {
        slug: "gpu-claude",
        name: "GPU Claude",
        harness: "claude-code",
        status: "active",
        runtimeId: row!.id,
      });
      // A retired agent frees its pair and is not listed.
      await support.seedAgent(tenant, {
        slug: "gpu-old",
        harness: "codex",
        status: "archived",
        runtimeId: row!.id,
      });
      const host = await support.seedHost(tenant, agent.agentKey!);
      await withSystemDb((tx) =>
        tx
          .update(schema.tachoHosts)
          .set({ runtimeId: row!.id })
          .where(eq(schema.tachoHosts.id, host.id)),
      );

      const out = runtimeList.output.parse(
        await inScope(() => runtimeListHandler({}, ctx())),
      );
      const gpu = out.items.find((i) => i.id === created.runtime.id);
      expect(gpu).toMatchObject({
        name: "GPU box",
        slug: "gpu-box",
        liveHosts: 1,
        agents: [
          {
            id: agent.publicId,
            name: "GPU Claude",
            slug: "gpu-claude",
            harness: "claude-code",
          },
        ],
      });
      // Runtimes come back in name order.
      expect(out.items.map((i) => i.name)).toEqual(
        [...out.items.map((i) => i.name)].sort((a, b) => a.localeCompare(b)),
      );
    });

    it("an operator enrollment binds the runtime its hostname names, created once, with a suffix on a slug clash", async () => {
      const scope = { orgId: tenant.orgId, workspaceId: tenant.workspaceId };
      const first = await withSystemDb((tx) =>
        findOrCreateHostRuntime(tx, scope, "Build-Box.local", tenant.userId),
      );
      const again = await withSystemDb((tx) =>
        findOrCreateHostRuntime(tx, scope, "build-box.local", tenant.userId),
      );
      expect(again.id).toBe(first.id);
      expect(first.slug).toBe("build-box");
      const clash = await withSystemDb((tx) =>
        findOrCreateHostRuntime(tx, scope, "Build Box", tenant.userId),
      );
      expect(clash.id).not.toBe(first.id);
      expect(clash.slug).toBe("build-box-2");
    });
  },
);
