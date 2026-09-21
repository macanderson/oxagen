// The agent identity writes: register_agent, rotate_agent_credential,
// suspend_agent, retire_agent (#2956, ADR-057 decision 3).
//
// The role gate is proven with a tx double, the way auth.cli.authorize.test.ts
// proves its own: the org is tier-free in every case, so a refusal can only
// come from the handler. The writes themselves are proven against a real
// Postgres (the credential row, the principal status, the host revocation and
// the queued command are properties of the SQL); that block runs where
// DATABASE_URL is set (CI's `test` job) and skips otherwise:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/agent.identity.test.ts
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
  emitSecurityEvent: vi.fn(),
  gate: {
    enabled: false,
    /** The creator an API key resolves to, or none. */
    keyCreator: null as string | null,
    principalId: null as string | null,
    roleName: null as string | null,
  },
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// When `mocks.gate.enabled`, withTenantDb answers the selects the role gate
// runs (the API key's creator, the principal, the role), answers every other
// select with no row,
// and throws on a write. A refusal past the gate is therefore one of two
// known shapes: `not_found` from the identity read, or the store's own
// error from the first insert; the positive below names which.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const gateTx = () => ({
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === real.schema.apiKeys
            ? mocks.gate.keyCreator
              ? [{ createdById: mocks.gate.keyCreator }]
              : []
            : table === real.schema.principals
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
    update: () => {
      throw new Error("a write reached the store");
    },
  });
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      mocks.gate.enabled ? fn(gateTx()) : real.withTenantDb(fn as never),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { agentRegisterHandler } from "./agent.register";
import { agentCredentialRotateHandler } from "./agent.credential.rotate";
import { agentSuspendHandler } from "./agent.suspend";
import { agentRetireHandler } from "./agent.retire";
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import type { CapabilityContext } from "@oxagen/oxagen";
import { makeCTX } from "./test-utils/fixtures";

const REGISTER_INPUT = agentRegister.input.parse({
  slug: "release-bot",
  name: "Release bot",
  harness: "stella",
});

const WRITES = [
  [
    "register_agent",
    (ctx: CapabilityContext = makeCTX()) =>
      agentRegisterHandler(REGISTER_INPUT, ctx),
  ],
  [
    "rotate_agent_credential",
    (ctx: CapabilityContext = makeCTX()) =>
      agentCredentialRotateHandler(
        agentCredentialRotate.input.parse({ agentId: "release-bot" }),
        ctx,
      ),
  ],
  [
    "suspend_agent",
    (ctx: CapabilityContext = makeCTX()) =>
      agentSuspendHandler(
        agentSuspend.input.parse({ agentId: "release-bot" }),
        ctx,
      ),
  ],
  [
    "retire_agent",
    (ctx: CapabilityContext = makeCTX()) =>
      agentRetireHandler(
        agentRetire.input.parse({ agentId: "release-bot" }),
        ctx,
      ),
  ],
] as const;

const forbidden =
  (reason: string) =>
  (err: unknown): boolean =>
    isHandlerError(err) && err.code === "forbidden" && err.reason === reason;

/**
 * The gate passed: register's next step is the agent insert, which the
 * double refuses with its own error; the other three read the identity first
 * and the double answers with no row, so they refuse `not_found`.
 */
const pastGate =
  (name: (typeof WRITES)[number][0]) =>
  (err: unknown): boolean =>
    name === "register_agent"
      ? err instanceof Error && /a write reached the store/.test(err.message)
      : isHandlerError(err) &&
        err.code === "not_found" &&
        err.reason === "agent_not_found";

/** An API-key call: no signed-in user, the key's id. */
const KEY_CTX = makeCTX({ userId: null, apiKeyId: "aky_row", surface: "mcp" });

describe("agent identity writes: the role gate on a tier-free org", () => {
  beforeEach(() => {
    mocks.gate.enabled = true;
    mocks.gate.keyCreator = "usr_creator";
    mocks.gate.principalId = "prn_row";
    mocks.gate.roleName = null;
    mocks.emitSecurityEvent.mockClear();
  });

  it.each(WRITES)(
    "%s refuses a call with no user and no API key",
    async (_name, call) => {
      await expect(
        call(makeCTX({ userId: null, apiKeyId: null })),
      ).rejects.toSatisfy(forbidden("no_principal"));
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it.each(WRITES)(
    "%s refuses an API key with no creator",
    async (_name, call) => {
      mocks.gate.keyCreator = null;
      mocks.gate.roleName = "Owner";
      await expect(call(KEY_CTX)).rejects.toSatisfy(forbidden("no_principal"));
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it.each(WRITES)(
    "%s refuses an API key whose creator is an org Member",
    async (_name, call) => {
      mocks.gate.roleName = "Member";
      await expect(call(KEY_CTX)).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it.each(WRITES)(
    "%s lets an API key whose creator is an org Owner past the gate",
    async (name, call) => {
      mocks.gate.roleName = "Owner";
      await expect(call(KEY_CTX)).rejects.toSatisfy(pastGate(name));
    },
  );

  it.each(WRITES)(
    "%s refuses a user with no principal",
    async (_name, call) => {
      mocks.gate.principalId = null;
      await expect(call()).rejects.toSatisfy(forbidden("org_role_required"));
    },
  );

  for (const role of ["Member", "Viewer", "Billing", "Compliance"]) {
    it.each(WRITES)(`%s refuses an org ${role}`, async (_name, call) => {
      mocks.gate.roleName = role;
      await expect(call()).rejects.toSatisfy(forbidden("org_role_required"));
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    });
  }

  it.each(WRITES)("%s lets an org Admin past the gate", async (name, call) => {
    mocks.gate.roleName = "Admin";
    await expect(call()).rejects.toSatisfy(pastGate(name));
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "agent identity writes against Postgres",
  async () => {
    const { withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { and, eq, isNull } = await import("drizzle-orm");
    const support = await import(
      "@oxagen/agent/handlers/_agent-identity.test-support"
    );
    const { agentGetHandler } = await import(
      "@oxagen/agent/handlers/agent.get"
    );
    // The resolvers subpath: the barrel builds the Better Auth instance at
    // import, which needs the login env this block does not carry.
    const { resolveApiKey } = await import("@oxagen/auth/resolvers");

    let owner: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    const inScope = <T>(t: typeof owner, fn: () => Promise<T>) =>
      runInTenantScope({ orgId: t.orgId, workspaceId: t.workspaceId }, fn);
    const ctx = () => support.ctxFor(owner, owner.userId);

    const eventTypes = () =>
      mocks.emitSecurityEvent.mock.calls.map(
        (c) => (c[0] as { eventType: string }).eventType,
      );

    beforeAll(async () => {
      mocks.gate.enabled = false;
      owner = await support.seedTenant("free");
      orgIds.push(owner.orgId);
      userIds.push(owner.userId);
      await support.seedMember(owner, "Owner");
    });

    afterAll(async () => {
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    beforeEach(() => {
      mocks.emitSecurityEvent.mockClear();
    });

    let registered: Awaited<ReturnType<typeof agentRegisterHandler>>;
    let rotatedSecret: string;
    let firstRetire: Awaited<ReturnType<typeof agentRetireHandler>>;

    it("register_agent mints the row, its principal and one credential whose secret is returned once and never stored", async () => {
      registered = await inScope(owner, () =>
        agentRegisterHandler(REGISTER_INPUT, ctx()),
      );
      expect(agentRegister.output.parse(registered)).toEqual(registered);
      expect(registered.agentKey).toBe(
        `${owner.orgNamespace}.${owner.workspaceNamespace}.release-bot`,
      );
      const stored = await withSystemDb((tx) =>
        tx
          .select({
            keyHash: schema.apiKeys.keyHash,
            keyPrefix: schema.apiKeys.keyPrefix,
            scope: schema.apiKeys.scope,
          })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.publicId, registered.credential.id)),
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.keyHash).not.toBe(registered.credential.secret);
      expect(
        registered.credential.secret.startsWith(stored[0]!.keyPrefix),
      ).toBe(true);
      expect(stored[0]!.scope).toMatchObject({
        purpose: "agent_credential_v1",
        agent_id: registered.agentId,
        principal_id: registered.principalId,
      });
      expect(eventTypes()).toEqual(["agent.registered", "api_key.created"]);
      // The credential is locked to its purpose: no surface authenticates it
      // as a bearer, so it never carries its minter's authority (ADR-057 §3).
      expect(await resolveApiKey(registered.credential.secret)).toEqual({
        ok: false,
        kind: "purpose_locked",
      });

      const read = await inScope(owner, () =>
        agentGetHandler({ agentId: "release-bot" }, ctx()),
      );
      expect(read.identity.status).toBe("enrolled");
      expect(read.identity.harness).toBe("stella");
      expect(read.identity.operatorId).toBe(owner.userPublicId);
      expect(read.credentials.map((c) => c.id)).toEqual([
        registered.credential.id,
      ]);
    });

    it("register_agent refuses a slug the workspace already holds", async () => {
      await expect(
        inScope(owner, () => agentRegisterHandler(REGISTER_INPUT, ctx())),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isHandlerError(err) &&
          err.code === "conflict" &&
          err.reason === "agent_slug_taken",
      );
    });

    it("rotate_agent_credential retires the live key and mints one more in the same write", async () => {
      const out = await inScope(owner, () =>
        agentCredentialRotateHandler(
          { agentId: registered.agentId, validityDays: 30 },
          ctx(),
        ),
      );
      expect(out.revokedCredentialId).toBe(registered.credential.id);
      expect(out.credential.id).not.toBe(registered.credential.id);
      expect(out.credential.secret).not.toBe(registered.credential.secret);
      expect(eventTypes()).toEqual(["api_key.revoked", "api_key.created"]);
      rotatedSecret = out.credential.secret;
      expect(await resolveApiKey(registered.credential.secret)).toEqual({
        ok: false,
        kind: "invalid",
      });
      expect(await resolveApiKey(rotatedSecret)).toEqual({
        ok: false,
        kind: "purpose_locked",
      });
      const live = await withSystemDb((tx) =>
        tx
          .select({ publicId: schema.apiKeys.publicId })
          .from(schema.apiKeys)
          .where(
            and(
              eq(schema.apiKeys.orgId, owner.orgId),
              isNull(schema.apiKeys.deletedAt),
            ),
          ),
      );
      expect(live.map((k) => k.publicId)).toEqual([out.credential.id]);
    });

    it("suspend_agent flips the principal, reads back as suspended, and resume restores it without a new credential", async () => {
      const suspended = await inScope(owner, () =>
        agentSuspendHandler({ agentId: "release-bot", suspended: true }, ctx()),
      );
      expect(suspended.status).toBe("suspended");
      expect(eventTypes()).toEqual(["agent.suspended"]);
      const read = await inScope(owner, () =>
        agentGetHandler({ agentId: "release-bot" }, ctx()),
      );
      expect(read.identity.status).toBe("suspended");

      mocks.emitSecurityEvent.mockClear();
      const again = await inScope(owner, () =>
        agentSuspendHandler({ agentId: "release-bot", suspended: true }, ctx()),
      );
      expect(again.status).toBe("suspended");
      expect(again.changedAt).toBe(suspended.changedAt);
      expect(eventTypes()).toEqual([]);

      const resumed = await inScope(owner, () =>
        agentSuspendHandler(
          { agentId: "release-bot", suspended: false },
          ctx(),
        ),
      );
      expect(resumed.status).toBe("active");
      expect(eventTypes()).toEqual(["agent.resumed"]);
      const after = await inScope(owner, () =>
        agentGetHandler({ agentId: "release-bot" }, ctx()),
      );
      expect(after.identity.status).toBe("enrolled");
      expect(
        after.credentials.filter((c) => c.revokedAt === null),
      ).toHaveLength(1);
    });

    it("retire_agent archives the row, suspends the principal, revokes the credential and the live host, and queues the host's revoke", async () => {
      // One host per agent key per org (tacho_hosts_agent_key_uniq).
      const agentKey = registered.agentKey!;
      const host = await support.seedHost(owner, agentKey, {
        hostname: "live",
      });

      const out = await inScope(owner, () =>
        agentRetireHandler({ agentId: "release-bot", reason: "done" }, ctx()),
      );
      firstRetire = out;
      const [validity] = await withSystemDb((tx) =>
        tx
          .select({
            validUntil: schema.agents.validUntil,
            principalId: schema.agents.principalId,
          })
          .from(schema.agents)
          .where(eq(schema.agents.publicId, registered.agentId)),
      );
      expect(validity?.validUntil?.toISOString()).toBe(out.retiredAt);
      expect(validity?.principalId).toBe(registered.principalId);
      expect(out).toMatchObject({
        agentId: registered.agentId,
        status: "retired",
        revokedCredentials: 1,
        revokedHosts: 1,
        revokedMandates: 0,
      });
      expect(eventTypes()).toEqual(["agent.retired", "api_key.revoked"]);

      const [stored] = await withSystemDb((tx) =>
        tx
          .select({
            status: schema.tachoHosts.status,
            revokeReason: schema.tachoHosts.revokeReason,
            revokedAt: schema.tachoHosts.revokedAt,
          })
          .from(schema.tachoHosts)
          .where(eq(schema.tachoHosts.id, host.id)),
      );
      expect(stored).toMatchObject({ status: "revoked", revokeReason: "done" });
      expect(stored!.revokedAt).not.toBeNull();
      const keys = await withSystemDb((tx) =>
        tx
          .select({
            id: schema.apiKeys.id,
            deletedAt: schema.apiKeys.deletedAt,
          })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.orgId, owner.orgId)),
      );
      expect(keys.length).toBeGreaterThanOrEqual(3);
      expect(keys.every((k) => k.deletedAt !== null)).toBe(true);
      expect(await resolveApiKey(rotatedSecret)).toEqual({
        ok: false,
        kind: "invalid",
      });
      const commands = await withSystemDb((tx) =>
        tx
          .select({
            hostId: schema.tachoControlCommands.hostId,
            targetKind: schema.tachoControlCommands.targetKind,
            targetId: schema.tachoControlCommands.targetId,
            command: schema.tachoControlCommands.command,
            payload: schema.tachoControlCommands.payload,
            reason: schema.tachoControlCommands.reason,
          })
          .from(schema.tachoControlCommands)
          .where(eq(schema.tachoControlCommands.orgId, owner.orgId)),
      );
      expect(commands).toEqual([
        {
          hostId: host.id,
          targetKind: "host",
          targetId: host.publicId,
          command: "revoke",
          payload: { reason: "done" },
          reason: "done",
        },
      ]);

      const read = await inScope(owner, () =>
        agentGetHandler({ agentId: "release-bot" }, ctx()),
      );
      expect(read.identity.status).toBe("retired");
      expect(read.identity.principalId).toBe(registered.principalId);
      expect(read.hosts.map((h) => h.revokedAt !== null)).toEqual([true]);
    });

    it("a retired identity answers retire again with the recorded instant, without a write, and refuses rotate and suspend", async () => {
      mocks.emitSecurityEvent.mockClear();
      const again = await inScope(owner, () =>
        agentRetireHandler({ agentId: "release-bot" }, ctx()),
      );
      expect(again).toEqual({
        agentId: registered.agentId,
        status: "retired",
        revokedCredentials: 0,
        revokedHosts: 0,
        revokedMandates: 0,
        retiredAt: firstRetire.retiredAt,
      });
      expect(eventTypes()).toEqual([]);
      const retired = (err: unknown) =>
        isHandlerError(err) &&
        err.code === "conflict" &&
        err.reason === "agent_retired";
      await expect(
        inScope(owner, () =>
          agentCredentialRotateHandler(
            { agentId: "release-bot", validityDays: 180 },
            ctx(),
          ),
        ),
      ).rejects.toSatisfy(retired);
      await expect(
        inScope(owner, () =>
          agentSuspendHandler(
            { agentId: "release-bot", suspended: false },
            ctx(),
          ),
        ),
      ).rejects.toSatisfy(retired);
    });

    it("an unknown agent is not_found for every write", async () => {
      const notFound = (err: unknown) =>
        isHandlerError(err) &&
        err.code === "not_found" &&
        err.reason === "agent_not_found";
      await expect(
        inScope(owner, () =>
          agentCredentialRotateHandler(
            { agentId: "nobody", validityDays: 180 },
            ctx(),
          ),
        ),
      ).rejects.toSatisfy(notFound);
      await expect(
        inScope(owner, () =>
          agentSuspendHandler({ agentId: "nobody", suspended: true }, ctx()),
        ),
      ).rejects.toSatisfy(notFound);
      await expect(
        inScope(owner, () => agentRetireHandler({ agentId: "nobody" }, ctx())),
      ).rejects.toSatisfy(notFound);
    });
  },
);
