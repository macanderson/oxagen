import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  AttemptNotWritableError,
  prepareAttemptEvent,
  RunStoreStateError,
  type RunStoreOptions,
} from "@oxagen/run-ledger";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { runFramesIngest } from "@oxagen/oxagen/contracts/run.frames.ingest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  store: vi.fn(),
  role: vi.fn(),
  actor: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.withTenantDb,
  withOrgDb: mocks.withTenantDb,
}));
vi.mock("@oxagen/run-ledger", async (original) => ({
  ...(await original<typeof import("@oxagen/run-ledger")>()),
  createPostgresRunStore: mocks.store,
}));
import { runFramesIngestHandler } from "./run.frames.ingest";

const scope = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const runId = "00000000-0000-4000-8000-000000000003";
const attemptId = "00000000-0000-4000-8000-000000000004";
const apiKeyId = "00000000-0000-4000-8000-000000000005";
const ctx = makeCTX({ ...scope, userId: null, apiKeyId });
const input = {
  events: [
    {
      attemptSeq: 1,
      eventType: "tool.call_completed",
      observedAt: "2026-09-20T00:00:00Z",
      payload: {},
    },
  ],
};
const dialect = new PgDialect();
let rows: Array<unknown[]>;
let predicates: Array<{ sql: string; params: unknown[] }>;
let locks: string[];
let writes: Array<Record<string, unknown>>;
let append: ReturnType<typeof vi.fn>;
let options: RunStoreOptions;
const key = (over: Record<string, unknown> = {}) => ({
  id: apiKeyId,
  scope: { purpose: "ledger_run_v1", run_id: runId, attempt_id: attemptId },
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});
const tx = {
  select: () => ({
    from: () => ({
      where: (where: SQL) => {
        predicates.push(dialect.sqlToQuery(where));
        return {
          limit: () => {
            const result = rows.shift() ?? [];
            return {
              for: async (lock: string) => {
                locks.push(lock);
                return result;
              },
              then: (resolve: (value: unknown[]) => void) =>
                Promise.resolve(result).then(resolve),
            };
          },
        };
      },
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        writes.push(values);
      },
    }),
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockResolvedValue(undefined);
  mocks.actor.mockResolvedValue("issuer");
  predicates = [];
  locks = [];
  writes = [];
  rows = [[key()], [key()]];
  mocks.withTenantDb.mockImplementation((fn) => fn(tx));
  append = vi.fn(async ({ attemptId: actualAttemptId }) => {
    expect(actualAttemptId).toBe(attemptId);
    await options.authorizeAppend?.(
      tx as never,
      {
        attempt_id: attemptId,
        run_id: runId,
        org_id: scope.orgId,
        workspace_id: scope.workspaceId,
      } as never,
    );
    return { events: [], lastAttemptSeq: 1, lastRunSeq: "1" };
  });
  mocks.store.mockImplementation((actual) => {
    options = actual;
    return { appendAttemptBatch: append };
  });
});

describe("run credential ingress", () => {
  it("refuses ingress when the credential issuer no longer has a permitted role", async () => {
    mocks.role.mockRejectedValueOnce(new Error("org_role_required"));
    await expect(runFramesIngestHandler(input, ctx)).rejects.toThrow(
      "org_role_required",
    );
    expect(mocks.store).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it("derives the attempt from the credential and refreshes under a locked recheck", async () => {
    const before = Date.now();
    const result = await runFramesIngestHandler(input, ctx);
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(
      before + 15 * 60_000,
    );
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 15 * 60_000,
    );
    expect(locks).toEqual(["update"]);
    for (const query of predicates) {
      expect(query.params).toEqual([apiKeyId, scope.orgId, scope.workspaceId]);
      expect(query.sql).toContain('"deleted_at" is null');
    }
    expect(writes).toHaveLength(1);
  });

  it.each([
    ["expired", { expiresAt: new Date(0) }],
    ["unbounded", { expiresAt: null }],
    ["ordinary API key", { scope: {} }],
    ["other machine", { scope: { purpose: "tacho_host_v1" } }],
  ])("refuses a %s credential before appending", async (_label, over) => {
    rows = [[key(over)]];
    await expect(runFramesIngestHandler(input, ctx)).rejects.toMatchObject({
      reason: "run_token_invalid",
    });
    expect(append).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("refuses a key revoked while the request waited for the run lock", async () => {
    rows = [[key()], []];
    await expect(runFramesIngestHandler(input, ctx)).rejects.toMatchObject({
      reason: "run_token_invalid",
    });
    expect(writes).toHaveLength(0);
  });

  it.each(["run_id", "attempt_id"])(
    "refuses a changed %s binding at the locked recheck",
    async (field) => {
      rows = [
        [key()],
        [
          key({
            scope: {
              purpose: "ledger_run_v1",
              run_id: runId,
              attempt_id: attemptId,
              [field]: "00000000-0000-4000-8000-000000000099",
            },
          }),
        ],
      ];
      await expect(runFramesIngestHandler(input, ctx)).rejects.toMatchObject({
        reason: "run_token_invalid",
      });
      expect(writes).toHaveLength(0);
    },
  );

  it("refuses a session caller", async () => {
    await expect(
      runFramesIngestHandler(input, { ...ctx, apiKeyId: null }),
    ).rejects.toMatchObject({ reason: "run_token_invalid" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("has no caller-controlled tenant, run, or attempt fields", () => {
    for (const field of ["orgId", "workspaceId", "runId", "attemptId"])
      expect(
        runFramesIngest.input.safeParse({ ...input, [field]: runId }).success,
      ).toBe(false);
  });
});

describe("a malformed event (#3665)", () => {
  // The store prepares every event before it opens a transaction. These
  // witnesses run the ledger's real preparation, so the error the handler
  // sees is the one production raises.
  beforeEach(() => {
    append.mockImplementation(async ({ events }) => {
      events.map(prepareAttemptEvent);
      return { events: [], lastAttemptSeq: 1, lastRunSeq: "1" };
    });
  });

  const event = {
    attemptSeq: 1,
    eventType: "tool.call_completed",
    observedAt: "2026-09-20T00:00:00Z",
  };

  it.each([
    ["an unknown event type", { ...event, eventType: "made.up", payload: {} }],
    ["neither payload nor encrypted reference", event],
    [
      "both payload and encrypted reference",
      {
        ...event,
        payload: {},
        encryptedPayloadRef: "evb_0123456789abcdef0123",
        payloadDigest: `sha256:${"1".repeat(64)}`,
      },
    ],
    ["a payload off its schema", { ...event, payload: { nope: true } }],
  ])("answers %s as invalid input, not a server fault", async (_label, bad) => {
    const refusal = await runFramesIngestHandler(
      { events: [bad] } as never,
      ctx,
    ).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(CapabilityError);
    expect(refusal).toMatchObject({
      code: "invalid_input",
      capability: runFramesIngest.name,
    });
    // The API middleware maps `invalid_input` to 400 (apps/api error.ts).
    expect(writes).toHaveLength(0);
  });

  it("still answers a sealed attempt as a conflict", async () => {
    append.mockRejectedValueOnce(
      new AttemptNotWritableError(attemptId, "sealed"),
    );
    await expect(runFramesIngestHandler(input, ctx)).rejects.toMatchObject({
      code: "conflict",
      reason: "run_not_writable",
    });
  });

  it("passes a store fault through unchanged", async () => {
    const fault = new RunStoreStateError("a hole in the durable log");
    append.mockRejectedValueOnce(fault);
    await expect(runFramesIngestHandler(input, ctx)).rejects.toBe(fault);
  });
});

describe("the ingress receipt (#3665)", () => {
  it("names each event by sequence and digest, never by its row uuid", async () => {
    append.mockImplementationOnce(async () => {
      await options.authorizeAppend?.(
        tx as never,
        {
          attempt_id: attemptId,
          run_id: runId,
          org_id: scope.orgId,
          workspace_id: scope.workspaceId,
        } as never,
      );
      return {
        events: [
          {
            attemptSeq: 1,
            runSeq: "7",
            eventId: "00000000-0000-4000-8000-0000000000e1",
            eventDigest: `sha256:${"2".repeat(64)}`,
            idempotent: false,
          },
        ],
        lastAttemptSeq: 1,
        lastRunSeq: "7",
      };
    });
    const result = await runFramesIngestHandler(input, ctx);
    expect(result.events).toEqual([
      {
        attemptSeq: 1,
        runSeq: "7",
        eventDigest: `sha256:${"2".repeat(64)}`,
        idempotent: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(
      "00000000-0000-4000-8000-0000000000e1",
    );
    // The contract's output is strict, so a leaked field would fail the kernel.
    expect(runFramesIngest.output.safeParse(result).success).toBe(true);
    expect(
      runFramesIngest.output.safeParse({
        ...result,
        events: [{ ...result.events[0], eventId: "x" }],
      }).success,
    ).toBe(false);
  });
});
