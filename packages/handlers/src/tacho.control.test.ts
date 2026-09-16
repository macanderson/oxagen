import { generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  resolveActorOrgRole: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return { ...original, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));
vi.mock("./lib/api-key-authz", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/api-key-authz")>();
  return { ...original, resolveActorOrgRole: mocks.resolveActorOrgRole };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { verifyBundle } from "./lib/tacho-bundle-signing";
import { tachoBundleGetHandler } from "./tacho.bundle.get";
import { ackPatch, tachoCommandFetchHandler } from "./tacho.command.fetch";
import { tachoEnrollmentRevokeHandler } from "./tacho.enrollment.revoke";
import { tachoHostListHandler } from "./tacho.host.list";
import { tachoSessionGetHandler } from "./tacho.session.get";
import { tachoSessionListHandler } from "./tacho.session.list";

const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_UUID = "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b";
const OPERATOR: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "00000000-0000-0000-0000-0000000000aa",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
const MACHINE: CapabilityContext = {
  ...OPERATOR,
  userId: null,
  apiKeyId: "aky_host",
};
const PEM = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function host(overrides: Record<string, unknown> = {}) {
  return {
    id: HOST_ID,
    publicId: HOST_PUBLIC,
    apiKeyId: "aky_host",
    orgId: OPERATOR.orgId,
    workspaceId: OPERATOR.workspaceId,
    agentKey: "acme.core.cc-laptop",
    hostname: "laptop",
    platform: "darwin",
    osUser: "dev",
    status: "active",
    mode: "observe",
    harnesses: ["claude-code"],
    claudeVersionAtEnroll: "2.1.263",
    wrapperVersion: "2.1.1",
    managed: false,
    lastSeenAt: null,
    lastIngestAt: null,
    hooksOk: null,
    otelOk: null,
    spoolDepth: 0,
    sessionsCount: 1,
    unobservedSessionsCount: 0,
    incidentsOpen: 0,
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-09-08T10:00:00.000Z"),
    bundleVersionServed: 2,
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    sessionUuid: SESSION_UUID,
    harnessSessionId: "sess-1",
    hostId: HOST_ID,
    agentKey: "acme.core.cc-laptop",
    parentSessionUuid: null,
    subagentType: null,
    runtime: "claude-code",
    harness: "claude-code",
    harnessVersion: "2.1.263",
    outcome: "completed",
    enforcementTier: "observe",
    startedAt: new Date("2026-09-08T10:06:03.000Z"),
    lastEventAt: new Date("2026-09-08T10:06:30.000Z"),
    endedAt: new Date("2026-09-08T10:06:30.000Z"),
    cwd: "/home/dev/proj",
    gitBranch: "main",
    modelInitial: "claude-haiku-4-5-20251001",
    numTurns: 2,
    numToolCalls: 4,
    numModelCalls: 3,
    totalCostMicros: 97_937,
    seqCount: 207,
    chainVerified: true,
    unobservedTail: false,
    title: "probe",
    anthropicUserEmail: null,
    entrypoint: "sdk-cli",
    terminalType: "ghostty",
    permissionModeInitial: "bypassPermissions",
    permissionModeFinal: "bypassPermissions",
    effort: "high",
    endReason: "other",
    terminalReason: null,
    projectDir: "/home/dev/proj",
    gitRemoteDigest: null,
    gitHeadShaStart: null,
    worktreeBranch: null,
    inputTokens: 66,
    outputTokens: 1714,
    cacheReadTokens: 125_715,
    cacheCreationTokens: 43_001,
    thinkingTokens: 1029,
    durationMs: 11_297,
    linesAdded: 0,
    linesRemoved: 0,
    numSubagents: 1,
    policyDenies: 0,
    genesisHash: `sha256:${"a".repeat(64)}`,
    lastHash: `sha256:${"b".repeat(64)}`,
    completenessGaps: [],
    replayGrade: null,
    toolsAvailable: ["Read"],
    mcpServers: [{ name: "github", status: "connected" }],
    envSnapshot: { CLAUDE_EFFORT: "high" },
    ...overrides,
  };
}

interface Fake {
  hosts: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function tableName(table: unknown): string {
  for (const symbol of Object.getOwnPropertySymbols(table as object)) {
    if (symbol.description === "drizzle:Name")
      return (table as Record<symbol, string>)[symbol] ?? "?";
  }
  return "?";
}

const HOST_KEY = {
  id: "aky_host",
  scope: { purpose: "tacho_host_v1", host_enrollment_id: HOST_PUBLIC },
  createdByUserId: OPERATOR.userId,
  stellaTelemetryEnrollmentId: null,
};

function wire(db: Fake, apiKey: Record<string, unknown> = HOST_KEY): void {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: {
          apiKeys: { findFirst: async () => apiKey },
          tachoHosts: {
            findFirst: async () => db.hosts[0],
            findMany: async () => db.hosts,
          },
          tachoSessions: {
            findFirst: async () => db.sessions[0],
            findMany: async () => db.sessions,
          },
          tachoSessionModels: {
            findMany: async () => [
              {
                model: "m",
                canonicalModel: null,
                provider: null,
                requests: 1,
                inputTokens: 1,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                thinkingTokens: 0,
                costMicros: 5,
              },
            ],
          },
          tachoSessionFiles: {
            findMany: async () => [
              {
                path: "/a",
                reads: 1,
                writes: 0,
                edits: 0,
                deletes: 0,
                firstSeq: 3,
                lastSeq: 3,
              },
            ],
          },
          tachoSessionCommands: {
            findMany: async () => [
              {
                seq: 5,
                toolUseId: "t",
                commandHead: "echo hi",
                bashCommand: "echo",
                status: "ok",
                durationMs: 1,
                decision: null,
                policyRule: null,
              },
            ],
          },
          tachoIncidents: { findMany: async () => [] },
          authorizationDenyGenerations: {
            findMany: async () => [{ workspaceId: null, generation: 1 }],
          },
          retentionPolicyVersions: { findFirst: async () => undefined },
          tachoControlCommands: {
            findMany: async () =>
              db.commands.filter((c) => c["outcome"] === "queued"),
          },
        },
        select: () => ({ from: () => ({ where: async () => [{ value: 2 }] }) }),
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => {
            db.inserts.push({ table: tableName(table), values });
            return { returning: async () => [{ publicId: "tcm_new" }] };
          },
        }),
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              db.updates.push({ table: tableName(table), values });
              const result = Promise.resolve([
                { id: "x" },
              ]) as Promise<unknown> & { returning: () => Promise<unknown> };
              result.returning = async () =>
                tableName(table) === "control_commands" ? [{ id: "x" }] : [];
              return result;
            },
          }),
        }),
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActorOrgRole.mockResolvedValue("Admin");
  vi.stubEnv("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", PEM.replace(/\n/g, "\\n"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("get_tacho_bundle", () => {
  it("signs a bundle, answers not_modified on a matching etag, and refuses other hosts' keys", async () => {
    const db: Fake = {
      hosts: [host()],
      sessions: [],
      commands: [],
      updates: [],
      inserts: [],
    };
    wire(db);
    const first = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC },
      MACHINE,
    );
    expect(first.not_modified).toBe(false);
    expect(first.bundle?.version).toBe(3);
    expect(
      first.bundle &&
        verifyBundle(
          first.bundle,
          (await import("./lib/tacho-bundle-signing")).bundleSignerFromPem(PEM)
            .publicKeyPem,
        ),
    ).toBe(true);
    const second = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC, etag: first.etag },
      MACHINE,
    );
    expect(second).toEqual({
      not_modified: true,
      etag: first.etag,
      bundle: null,
    });
    expect(db.updates.find((u) => u.table === "hosts")?.values).toMatchObject({
      bundleEtagServed: first.etag,
    });
    await expect(
      tachoBundleGetHandler(
        { host_enrollment_id: "tch_zzzzzzzzzzzzzzzzzzzzzz" },
        MACHINE,
      ),
    ).rejects.toThrow(/mismatch/);
    await expect(
      tachoBundleGetHandler({ host_enrollment_id: HOST_PUBLIC }, OPERATOR),
    ).rejects.toThrow(/API key required/);
  });
});

describe("fetch_commands", () => {
  const FETCH = { schema: "tacho.commands.v2" } as const;

  it("acknowledges in the §7.4 vocabulary, expires what the clock passed, and drains queued commands as sent", async () => {
    const db: Fake = {
      hosts: [host()],
      sessions: [],
      commands: [
        {
          id: "c1",
          publicId: "tcm_1",
          hostId: HOST_ID,
          outcome: "queued",
          command: "steer",
          payload: { text: "wrap up", session_uuid: SESSION_UUID },
          requestedMode: "interrupt",
          deliveryMode: "next_step",
          degradedReason: "harness_tier",
          reason: "deploy window closes at five",
          issuedAt: new Date("2026-09-08T10:00:00.000Z"),
          expiresAt: null,
        },
      ],
      updates: [],
      inserts: [],
    };
    wire(db);
    const output = await tachoCommandFetchHandler(
      {
        ...FETCH,
        host_enrollment_id: HOST_PUBLIC,
        acknowledgements: [
          { command_id: "tcm_0", status: "applied", applied_at_seq: 9 },
          { command_id: "tcm_r", status: "received" },
          { command_id: "tcm_f", status: "failed", detail: "session gone" },
        ],
        daemon: { hooks_ok: false },
      },
      MACHINE,
    );
    expect(output.acknowledged).toBe(3);
    expect(output.control.commands).toEqual([
      {
        id: "tcm_1",
        command: "steer",
        session_uuid: SESSION_UUID,
        payload: { text: "wrap up", session_uuid: SESSION_UUID },
        requested_mode: "interrupt",
        delivery_mode: "next_step",
        degraded_reason: "harness_tier",
        reason: "deploy window closes at five",
        issued_at: "2026-09-08T10:00:00.000Z",
        expires_at: null,
      },
    ]);
    const commandUpdates = db.updates
      .filter((u) => u.table === "control_commands")
      .map((u) => u.values);
    expect(commandUpdates[0]).toMatchObject({
      outcome: "applied",
      appliedAtSeq: 9,
    });
    expect(commandUpdates[0]?.["appliedAt"]).toBeInstanceOf(Date);
    expect(commandUpdates[0]?.["acknowledgedAt"]).toBeInstanceOf(Date);
    expect(commandUpdates[1]).toMatchObject({ outcome: "received" });
    expect(commandUpdates[1]).not.toHaveProperty("acknowledgedAt");
    expect(commandUpdates[2]).toMatchObject({
      outcome: "failed",
      outcomeDetail: "session gone",
    });
    // The sweep runs before the drain, then the drained rows become sent.
    expect(commandUpdates.slice(3).map((v) => v["outcome"])).toEqual([
      "expired",
      "sent",
    ]);
    expect(db.updates.find((u) => u.table === "hosts")?.values).toMatchObject({
      hooksOk: false,
    });
  });

  it("refuses a caller without the host's API key (negative)", async () => {
    const db: Fake = {
      hosts: [host()],
      sessions: [],
      commands: [],
      updates: [],
      inserts: [],
    };
    wire(db);
    await expect(
      tachoCommandFetchHandler(
        { ...FETCH, host_enrollment_id: HOST_PUBLIC, acknowledgements: [] },
        OPERATOR,
      ),
    ).rejects.toThrow(/API key required/);
    expect(db.updates).toEqual([]);
  });
});

describe("ackPatch", () => {
  const now = new Date("2026-09-08T10:00:00.000Z");
  it("writes the timestamps and the frame sequence only for the status that proves them", () => {
    expect(ackPatch({ command_id: "c", status: "received" }, now)).toEqual({
      outcome: "received",
      outcomeDetail: null,
      updatedAt: now,
    });
    expect(ackPatch({ command_id: "c", status: "acknowledged" }, now)).toEqual({
      outcome: "acknowledged",
      outcomeDetail: null,
      updatedAt: now,
      acknowledgedAt: now,
    });
    expect(
      ackPatch({ command_id: "c", status: "applied", applied_at_seq: 4 }, now),
    ).toEqual({
      outcome: "applied",
      outcomeDetail: null,
      updatedAt: now,
      acknowledgedAt: now,
      appliedAt: now,
      appliedAtSeq: 4,
    });
    expect(
      ackPatch(
        {
          command_id: "c",
          status: "expired",
          detail: "expired before a boundary",
        },
        now,
      ),
    ).toEqual({
      outcome: "expired",
      outcomeDetail: "expired before a boundary",
      updatedAt: now,
    });
    expect(
      ackPatch({ command_id: "c", status: "failed", detail: "gone" }, now),
    ).toEqual({ outcome: "failed", outcomeDetail: "gone", updatedAt: now });
  });
});

describe("revoke_tacho_enrollment", () => {
  it("revokes once, retires the key, queues the command, and is idempotent", async () => {
    const db: Fake = {
      hosts: [host()],
      sessions: [],
      commands: [],
      updates: [],
      inserts: [],
    };
    wire(db);
    const first = await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: HOST_PUBLIC, reason: "lost" },
      OPERATOR,
    );
    expect(first.status).toBe("revoked");
    expect(db.updates.map((u) => u.table)).toEqual(["hosts", "api_keys"]);
    expect(db.inserts[0]?.values).toMatchObject({
      command: "revoke",
      targetKind: "host",
      targetId: HOST_PUBLIC,
      reason: "lost",
      payload: { reason: "lost" },
    });
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "api_key.revoked" }),
    );
    const already: Fake = {
      hosts: [
        host({
          status: "revoked",
          revokedAt: new Date("2026-09-01T00:00:00.000Z"),
        }),
      ],
      sessions: [],
      commands: [],
      updates: [],
      inserts: [],
    };
    wire(already);
    const second = await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: HOST_PUBLIC },
      OPERATOR,
    );
    expect(second.revokedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(already.updates).toEqual([]);
  });

  it("revokes with the operator's `oxagen login` key and refuses the host's own key", async () => {
    const db: Fake = {
      hosts: [host()],
      sessions: [],
      commands: [],
      updates: [],
      inserts: [],
    };
    // HOST_KEY names a creator on purpose: its machine purpose alone must
    // refuse it.
    wire(db);
    await expect(
      tachoEnrollmentRevokeHandler({ hostEnrollmentId: HOST_PUBLIC }, MACHINE),
    ).rejects.toThrow(/does not act for a person/);
    expect(db.updates).toEqual([]);

    wire(db, {
      id: "aky_cli",
      scope: {},
      createdByUserId: OPERATOR.userId,
      stellaTelemetryEnrollmentId: null,
    });
    const revoked = await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: HOST_PUBLIC, reason: "tacho unenroll" },
      { ...MACHINE, apiKeyId: "aky_cli" },
    );
    expect(revoked.status).toBe("revoked");
    expect(db.updates.find((u) => u.table === "hosts")?.values).toMatchObject({
      updatedByUserId: OPERATOR.userId,
    });
  });
});

describe("fleet reads", () => {
  it("lists hosts and sessions with cursors and reads one session's index", async () => {
    const db: Fake = {
      hosts: [host()],
      sessions: [sessionRow()],
      commands: [],
      updates: [],
      inserts: [],
    };
    wire(db);
    const hosts = await tachoHostListHandler({ limit: 50 }, OPERATOR);
    expect(hosts.hosts[0]).toMatchObject({
      hostEnrollmentId: HOST_PUBLIC,
      agentKey: "acme.core.cc-laptop",
      status: "active",
      sessionsCount: 1,
    });
    expect(hosts.nextCursor).toBeNull();

    const sessions = await tachoSessionListHandler(
      { limit: 50, includeChildren: false },
      OPERATOR,
    );
    expect(sessions.sessions[0]).toMatchObject({
      sessionUuid: SESSION_UUID,
      hostEnrollmentId: HOST_PUBLIC,
      totalCostMicros: 97_937,
      chainVerified: true,
    });

    const one = await tachoSessionGetHandler(
      { sessionUuid: SESSION_UUID },
      OPERATOR,
    );
    expect(one.session).toMatchObject({
      sessionUuid: SESSION_UUID,
      thinkingTokens: 1029,
      envSnapshot: { CLAUDE_EFFORT: "high" },
      toolsAvailable: ["Read"],
    });
    expect(one.models[0]?.model).toBe("m");
    expect(one.files[0]?.path).toBe("/a");
    expect(one.commands[0]?.bashCommand).toBe("echo");
    expect(one.checkpointCount).toBe(2);

    const paged: Fake = {
      hosts: [
        host(),
        host({ id: "h2", publicId: "tch_zzzzzzzzzzzzzzzzzzzzzz" }),
      ],
      sessions: [],
      commands: [],
      updates: [],
      inserts: [],
    };
    wire(paged);
    const page = await tachoHostListHandler({ limit: 1 }, OPERATOR);
    expect(page.hosts).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    await tachoHostListHandler(
      { limit: 1, cursor: page.nextCursor ?? "" },
      OPERATOR,
    );
    await tachoHostListHandler({ limit: 1, cursor: "garbage" }, OPERATOR);
  });

  it("answers not found for an unknown session", async () => {
    const db: Fake = {
      hosts: [],
      sessions: [],
      commands: [],
      updates: [],
      inserts: [],
    };
    wire(db);
    await expect(
      tachoSessionGetHandler({ sessionUuid: SESSION_UUID }, OPERATOR),
    ).rejects.toThrow(/not found/);
    const bySession = await tachoSessionListHandler(
      { hostEnrollmentId: HOST_PUBLIC, limit: 50, includeChildren: true },
      OPERATOR,
    );
    expect(bySession.sessions).toEqual([]);
  });
});
