import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CapabilityContext } from "@oxagen/oxagen";
const mock = vi.hoisted(() => ({
  db: vi.fn(),
  role: vi.fn(),
  user: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mock.db,
  withOrgDb: mock.db,
  hasColumnFresh: mock.ready,
  ambientPlaneKey: async () => "test",
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mock.role,
  resolveActingUserId: mock.user,
}));
import { tachoContainedLaunchRegisterHandler as handler } from "./tacho.contained_launch.register";
import { tachoContainedLaunchRegister as contract } from "@oxagen/oxagen/contracts/tacho.contained_launch.register";
const HOST = "tch_0123456789abcdefghjkmn";
const input = {
  host_enrollment_id: HOST,
  session_uuid: "11111111-1111-4111-8111-111111111111",
  genesis_hash: "a".repeat(64),
  measurement: {
    profile: "oxagen-linux-docker-v1" as const,
    containerId: "b".repeat(64),
    imageDigest: `sha256:${"c".repeat(64)}`,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    gatewayOnlyEgress: true as const,
    workspaceOnlyWrites: true as const,
    readOnlyHooks: true as const,
  },
};
const ctx: CapabilityContext = {
  orgId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  apiKeyId: "key-id",
  userId: null,
  requestId: "test",
  messageId: null,
  surface: "api",
};
function fixture() {
  const state = {
    key: {
      id: "key-id",
      scope: { purpose: "tacho_gateway_v1", host_enrollment_id: HOST },
    } as unknown,
    host: {
      id: "host-id",
      status: "active",
      expiresAt: new Date("2099-01-01"),
    } as unknown,
    record: undefined as Record<string, unknown> | undefined,
    predicates: [] as SQL[],
    writes: 0,
  };
  mock.db.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      query: {
        apiKeys: {
          findFirst: async ({ where }: { where: SQL }) => {
            state.predicates.push(where);
            return state.key;
          },
        },
        tachoHosts: {
          findFirst: async ({ where }: { where: SQL }) => {
            state.predicates.push(where);
            return state.host;
          },
        },
        tachoContainedLaunches: { findFirst: async () => state.record },
      },
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            state.writes++;
            state.record ??= value;
          },
        }),
      }),
    }),
  );
  return state;
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.ready.mockResolvedValue(true);
  mock.role.mockResolvedValue("Owner");
  mock.user.mockResolvedValue("operator");
});
describe("authenticated containment receipts", () => {
  it("binds a retryable immutable receipt to the credential host and tenant", async () => {
    const state = fixture();
    expect(await handler(input, ctx)).toEqual({ registered: true });
    expect(await handler(input, ctx)).toEqual({ registered: true });
    expect(state.record).toMatchObject({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      hostId: "host-id",
      sessionUuid: input.session_uuid,
      genesisHash: input.genesis_hash,
      measurement: input.measurement,
    });
    const key = new PgDialect().sqlToQuery(state.predicates[0]!);
    expect(key.sql).toContain('"deleted_at" is null');
    expect(key.sql).toContain('"expires_at" >');
    expect(key.params).toEqual(
      expect.arrayContaining([ctx.apiKeyId, ctx.orgId, ctx.workspaceId]),
    );
    const host = new PgDialect().sqlToQuery(state.predicates[1]!);
    expect(host.params).toEqual(
      expect.arrayContaining([HOST, ctx.orgId, ctx.workspaceId]),
    );
    expect(mock.role).toHaveBeenCalledWith(
      { ...ctx, userId: "operator" },
      { org: ["Owner", "Admin"] },
    );
    await expect(
      handler({ ...input, genesis_hash: "e".repeat(64) }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      handler(
        {
          ...input,
          measurement: { ...input.measurement, containerId: "e".repeat(64) },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(state.record?.genesisHash).toBe(input.genesis_hash);
  });
  it.each([
    undefined,
    { id: "k", scope: null },
    { id: "k", scope: { purpose: "tacho_host_v1", host_enrollment_id: HOST } },
    {
      id: "k",
      scope: { purpose: "tacho_gateway_v1", host_enrollment_id: "other" },
    },
  ])("rejects non-gateway or differently bound keys", async (key) => {
    const state = fixture();
    state.key = key;
    await expect(handler(input, ctx)).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(state.writes).toBe(0);
  });
  it.each(["paused", "suspended", "revoked", "expired", "missing"])(
    "rejects %s hosts",
    async (status) => {
      const state = fixture();
      state.host =
        status === "missing"
          ? undefined
          : {
              id: "host-id",
              status: status === "expired" ? "active" : status,
              expiresAt: new Date(
                status === "expired" ? "2000-01-01" : "2099-01-01",
              ),
            };
      await expect(handler(input, ctx)).rejects.toMatchObject({
        code: "authz_denied",
      });
      expect(state.writes).toBe(0);
    },
  );
  it("refuses before writes when the migration or operator privilege is absent", async () => {
    const state = fixture();
    mock.ready.mockResolvedValue(false);
    await expect(handler(input, ctx)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(state.writes).toBe(0);
    mock.role.mockRejectedValue(new Error("removed role"));
    await expect(handler(input, ctx)).rejects.toThrow("removed role");
    expect(state.writes).toBe(0);
  });
  it("refuses session authentication before reading data", async () => {
    fixture();
    await expect(
      handler(input, { ...ctx, apiKeyId: null }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mock.db).not.toHaveBeenCalled();
  });
  it.each([
    "profile",
    "containerId",
    "imageDigest",
    "configurationDigest",
    "gatewayOnlyEgress",
    "workspaceOnlyWrites",
    "readOnlyHooks",
  ])("requires the measured %s", (field) => {
    expect(contract.input.safeParse(input).success).toBe(true);
    expect(
      contract.input.safeParse({
        ...input,
        measurement: { ...input.measurement, [field]: false },
      }).success,
    ).toBe(false);
  });
});
