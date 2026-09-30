// create_runtime and list_runtimes (ADR-198, #4369), and the runtime a host
// enrollment binds. Both carry whether the runtime requires the contained
// launcher (ADR-204, #4372).
//
// The role gate is proven with a tx double, the way agent.identity.test.ts
// proves its own. The writes and reads are proven against a real Postgres;
// that block runs where DATABASE_URL is set (CI's `test` job):
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/runtime.create.test.ts
import { generateKeyPairSync } from "node:crypto";
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
    const { withSystemDb, withTenantDb } = await import("@oxagen/database");
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

    it("create_runtime records whether the runtime requires containment, false when left out", async () => {
      const contained = await inScope(() =>
        runtimeCreateHandler(
          { name: "Locked box", containmentRequired: true },
          ctx(),
        ),
      );
      const open = await inScope(() =>
        runtimeCreateHandler({ name: "Open box" }, ctx()),
      );
      const rows = await withSystemDb((tx) =>
        tx
          .select({
            publicId: schema.runtimes.publicId,
            containmentRequired: schema.runtimes.containmentRequired,
          })
          .from(schema.runtimes)
          .where(eq(schema.runtimes.orgId, tenant.orgId)),
      );
      const byId = new Map(rows.map((r) => [r.publicId, r]));
      expect(byId.get(contained.runtime.id)?.containmentRequired).toBe(true);
      expect(byId.get(open.runtime.id)?.containmentRequired).toBe(false);

      const listed = runtimeList.output.parse(
        await inScope(() => runtimeListHandler({}, ctx())),
      );
      expect(
        listed.items.find((i) => i.id === contained.runtime.id)
          ?.containmentRequired,
      ).toBe(true);
      expect(
        listed.items.find((i) => i.id === open.runtime.id)?.containmentRequired,
      ).toBe(false);
    });

    it("list_runtimes with an id reads that runtime alone, and none for an unknown id", async () => {
      const wanted = await inScope(() =>
        runtimeCreateHandler({ name: "Wanted box" }, ctx()),
      );
      await inScope(() => runtimeCreateHandler({ name: "Other box" }, ctx()));

      const one = runtimeList.output.parse(
        await inScope(() => runtimeListHandler({ id: wanted.runtime.id }, ctx())),
      );
      expect(one.items.map((i) => i.id)).toEqual([wanted.runtime.id]);

      const none = runtimeList.output.parse(
        await inScope(() =>
          runtimeListHandler({ id: "rtm_nosuchruntime" }, ctx()),
        ),
      );
      expect(none.items).toEqual([]);
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
        containmentRequired: false,
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

    it("an enrollment that carries containment makes the hostname's runtime require it, and never lifts it", async () => {
      const scope = { orgId: tenant.orgId, workspaceId: tenant.workspaceId };
      const open = await withSystemDb((tx) =>
        findOrCreateHostRuntime(tx, scope, "Contained-Box", tenant.userId),
      );
      expect(open.containmentRequired).toBe(false);
      const contained = await withSystemDb((tx) =>
        findOrCreateHostRuntime(tx, scope, "contained-box", tenant.userId, {
          containmentRequired: true,
        }),
      );
      expect(contained.id).toBe(open.id);
      expect(contained.containmentRequired).toBe(true);
      const later = await withSystemDb((tx) =>
        findOrCreateHostRuntime(tx, scope, "Contained-Box", tenant.userId, {
          containmentRequired: false,
        }),
      );
      expect(later.containmentRequired).toBe(true);
      const fresh = await withSystemDb((tx) =>
        findOrCreateHostRuntime(tx, scope, "Fresh-Box", tenant.userId, {
          containmentRequired: true,
        }),
      );
      expect(fresh.containmentRequired).toBe(true);
    });

    it("an unplaced agent whose version requires containment carries it to each runtime on its first enrollment there, and into that host's mandate", async () => {
      const { mintHostEnrollment, requireEnrollmentSigning } = await import(
        "./lib/tacho-host-enroll"
      );
      const pem = generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      vi.stubEnv("TACHO_ENROLLMENT_SIGNING_SECRET", "runtime-create-test");
      vi.stubEnv("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", pem.replace(/\n/g, "\\n"));
      vi.stubEnv("TACHO_INGEST_ENDPOINTS", "https://api.example.test/v1/tacho");

      // An agent the runtime backfill left unplaced: no runtime and no host,
      // with its requirement only in its active version's config.
      const unplaced = async (slug: string, config: Record<string, unknown>) => {
        const agent = await support.seedAgent(tenant, {
          slug,
          harness: "claude-code",
          status: "active",
          runtimeId: null,
        });
        await withSystemDb(async (tx) => {
          const [version] = await tx
            .insert(schema.agentVersions)
            .values({
              agentId: agent.id,
              version: 1,
              config,
              createdById: tenant.userId,
            })
            .returning({ id: schema.agentVersions.id });
          await tx
            .update(schema.agents)
            .set({ activeVersionId: version!.id })
            .where(eq(schema.agents.id, agent.id));
        });
        return agent;
      };
      const enroll = (
        agent: Awaited<ReturnType<typeof unplaced>>,
        hostname: string,
        fill: number,
      ) =>
        inScope(() =>
          withTenantDb((tx) =>
            mintHostEnrollment(tx, {
              orgId: tenant.orgId,
              workspaceId: tenant.workspaceId,
              userId: tenant.userId,
              agentKey: agent.agentKey!,
              agent: { id: agent.id, principalId: agent.principalId },
              facts: {
                hostname,
                osUser: "dev",
                platform: "darwin",
                devicePublicKey: `ed25519:${Buffer.alloc(32, fill).toString("base64")}`,
                harnesses: ["claude-code"],
                managed: false,
                validityDays: 30,
              },
              signing: requireEnrollmentSigning("runtime_create_test"),
              issuedAt: new Date(),
            }),
          ),
        );
      const runtimeOf = async (id: string | null) => {
        const [row] = await withSystemDb((tx) =>
          tx
            .select({
              slug: schema.runtimes.slug,
              containmentRequired: schema.runtimes.containmentRequired,
            })
            .from(schema.runtimes)
            .where(eq(schema.runtimes.id, id!)),
        );
        return row;
      };

      try {
        const strict = await unplaced("strict-claude", {
          containment: { required: true },
        });
        const minted = await enroll(strict, "Strict-Box.local", 5);
        expect(await runtimeOf(minted.host.runtimeId)).toEqual({
          slug: "strict-box",
          containmentRequired: true,
        });
        expect(minted.mandate.containment).toEqual({ required: true });
        // The enrollment binds the runtime; it does not move the agent.
        const [agentRow] = await withSystemDb((tx) =>
          tx
            .select({ runtimeId: schema.agents.runtimeId })
            .from(schema.agents)
            .where(eq(schema.agents.id, strict.id)),
        );
        expect(agentRow?.runtimeId).toBeNull();

        // An owner turns containment off and the host is revoked. Enrolling
        // the agent on the same machine again does not carry the requirement
        // back: the carry runs on the agent's first enrollment on a runtime.
        // One live host per agent key, so each host is revoked before the
        // agent enrolls again.
        const revoke = (hostId: string) =>
          withSystemDb((tx) =>
            tx
              .update(schema.tachoHosts)
              .set({ status: "revoked", revokedAt: new Date() })
              .where(eq(schema.tachoHosts.id, hostId)),
          );
        await withSystemDb((tx) =>
          tx
            .update(schema.runtimes)
            .set({ containmentRequired: false })
            .where(eq(schema.runtimes.id, minted.host.runtimeId!)),
        );
        await revoke(minted.host.id);
        const again = await enroll(strict, "Strict-Box.local", 7);
        expect(again.host.runtimeId).toBe(minted.host.runtimeId);
        expect(await runtimeOf(again.host.runtimeId)).toEqual({
          slug: "strict-box",
          containmentRequired: false,
        });
        expect(again.mandate.containment).toBeUndefined();

        // A machine the agent has not run on before still gets the carry.
        await revoke(again.host.id);
        const second = await enroll(strict, "Second-Box.local", 8);
        expect(await runtimeOf(second.host.runtimeId)).toEqual({
          slug: "second-box",
          containmentRequired: true,
        });

        const loose = await unplaced("loose-claude", {});
        const open = await enroll(loose, "Loose-Box.local", 6);
        expect(await runtimeOf(open.host.runtimeId)).toEqual({
          slug: "loose-box",
          containmentRequired: false,
        });
        expect(open.mandate.containment).toBeUndefined();

        // The backfill's SQL test (`->> 'required' = 'true'`) also matches
        // the string, so the carry counts it too, and the two cannot disagree
        // about one version.
        const quoted = await unplaced("quoted-claude", {
          containment: { required: "true" },
        });
        const boxed = await enroll(quoted, "Quoted-Box.local", 9);
        expect(await runtimeOf(boxed.host.runtimeId)).toEqual({
          slug: "quoted-box",
          containmentRequired: true,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  },
);
