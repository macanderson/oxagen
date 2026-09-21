import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { RunStoreOptions } from "@oxagen/run-ledger";
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
