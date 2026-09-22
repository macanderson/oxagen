import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  // The capture has to be installed inside `vi.hoisted`: the module under test
  // calls createFunction and destructures its result at import time, which
  // vitest hoists above the test file's own statements.
  createFunction: vi.fn(
    (
      opts: { onFailure: (ctx: unknown) => Promise<unknown> },
      _trigger: unknown,
      fn: (ctx: unknown) => Promise<unknown>,
    ): unknown[] => {
      captured.onFailure = opts.onFailure as never;
      captured.handler = fn as never;
      return [{}, {}];
    },
  ),
  runInTenantScope: vi.fn(),
  withTenantDb: vi.fn(),
  resolveRunRecord: vi.fn(),
  readSealedSegments: vi.fn(),
  buildRunExportBundle: vi.fn(),
  attesterKeyFromPem: vi.fn(),
  putBundle: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

type StepRun = (name: string, fn: () => unknown) => Promise<unknown>;
type FnCtx = { event: { data: unknown }; step: { run: StepRun } };
type Handler = (ctx: FnCtx) => Promise<unknown>;

/** Where the createFunction stub above leaves what the module handed it. */
const captured = vi.hoisted(
  () =>
    ({ onFailure: undefined, handler: undefined }) as {
      onFailure?: Handler;
      handler?: Handler;
    },
);

/**
 * The update chain the handler builds: `.update(table).set(values).where(cond)`.
 * Recording the arguments is what lets a test assert the row is narrowed by
 * BOTH the export id and the org id — the tenant guard that makes a
 * cross-tenant write impossible even if the scope were wrong.
 */
const updates: { table: unknown; values: Record<string, unknown> }[] = [];
const wheres: unknown[] = [];

vi.mock("@oxagen/database", () => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    withTenantDb: mocks.withTenantDb,
    schema: {
      runExports: { id: "run_exports.id", orgId: "run_exports.org_id" },
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({ putBundle: mocks.putBundle }),
}));

vi.mock("@oxagen/tacho", () => ({
  attesterKeyFromPem: mocks.attesterKeyFromPem,
}));

vi.mock("@oxagen/functions", () => ({
  // The real class, small enough to stand in for: the handler throws it and
  // the assertions below check the type, so a bare Error would not do.
  NonRetriableError: class NonRetriableError extends Error {},
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));

vi.mock("../lib/run-record", () => ({
  resolveRunRecord: mocks.resolveRunRecord,
  readSealedSegments: mocks.readSealedSegments,
}));

vi.mock("../lib/run-export-bundle", () => ({
  buildRunExportBundle: mocks.buildRunExportBundle,
}));

vi.mock("../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
    warn: vi.fn(),
  },
}));

vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

// Importing the module is what runs createFunction, so the capture is filled
// by the time these read it. The Inngest wrapper itself is not under test.
import { ATTESTER_KEY_ENV, RUN_EXPORT_EVENT } from "./evidence.run-export";

const handler = captured.handler as Handler;
const onFailure = captured.onFailure as Handler;

const EVENT = {
  exportId: "11111111-1111-4111-8111-111111111111",
  exportPublicId: "exp_abc",
  orgId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  runPublicId: "arun_deadbeef",
};

/** Names every step the handler ran, in order, so a skipped step is visible. */
const steps: string[] = [];
const step = {
  run: (async (name: string, fn: () => unknown) => {
    steps.push(name);
    return await fn();
  }) as StepRun,
};

function bundle() {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    digest: "sha256:bundle",
    manifest: { merkle_root: "sha256:root", frame_count: 7 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  steps.length = 0;
  updates.length = 0;
  wheres.length = 0;

  process.env[ATTESTER_KEY_ENV] = "-----BEGIN PRIVATE KEY-----\\nabc";

  // Both scope wrappers run their callback straight through, so the assertions
  // below see the real update chain rather than a stub's return value.
  mocks.runInTenantScope.mockImplementation(
    async (_scope: unknown, fn: () => unknown) => await fn(),
  );
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => unknown) =>
      await fn({
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => {
            updates.push({ table, values });
            return {
              where: (cond: unknown) => {
                wheres.push(cond);
                return Promise.resolve();
              },
            };
          },
        }),
      }),
  );

  mocks.attesterKeyFromPem.mockReturnValue({ kid: "key_1" });
  mocks.resolveRunRecord.mockResolvedValue({ source: "ledger", attempts: [] });
  mocks.readSealedSegments.mockResolvedValue([{ attemptId: "att_1" }]);
  mocks.buildRunExportBundle.mockReturnValue(bundle());
  mocks.putBundle.mockResolvedValue({ ref: "blob://exports/exp_abc" });
});

describe("evidence.run-export", () => {
  it("is triggered by the event the handler that queued the row dispatches", () => {
    expect(RUN_EXPORT_EVENT).toBe("evidence/run-export.build");
  });

  it("marks the row building, uploads once, then marks it ready with where the bundle landed", async () => {
    const result = await handler({ event: { data: EVENT }, step });

    expect(steps).toEqual(["mark-building", "build-and-upload", "mark-ready"]);
    expect(mocks.putBundle).toHaveBeenCalledTimes(1);
    expect(mocks.putBundle).toHaveBeenCalledWith({
      scope: { orgId: EVENT.orgId, workspaceId: EVENT.workspaceId },
      exportId: EVENT.exportPublicId,
      digest: "sha256:bundle",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(updates[0]?.values).toMatchObject({ status: "building" });
    expect(updates[1]?.values).toMatchObject({
      status: "ready",
      bundleRef: "blob://exports/exp_abc",
      bundleDigest: "sha256:bundle",
      bundleBytes: 3,
      merkleRoot: "sha256:root",
      frameCount: 7,
    });
    expect(updates[1]?.values.completedAt).toBeInstanceOf(Date);
    expect(result).toEqual({
      exportId: EVENT.exportId,
      bundleRef: "blob://exports/exp_abc",
    });
  });

  it("signs with the deployment's attester key, newlines unescaped", async () => {
    await handler({ event: { data: EVENT }, step });

    expect(mocks.attesterKeyFromPem).toHaveBeenCalledWith(
      "-----BEGIN PRIVATE KEY-----\nabc",
    );
    expect(mocks.buildRunExportBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: EVENT.runPublicId,
        source: "ledger",
        key: { kid: "key_1" },
      }),
    );
  });

  it("writes the row inside the run's tenant scope and narrows it by org as well as id", async () => {
    await handler({ event: { data: EVENT }, step });

    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: EVENT.orgId, workspaceId: EVENT.workspaceId },
      expect.any(Function),
    );
    // Both predicates, so a wrong scope still cannot reach another org's row.
    expect(JSON.stringify(wheres[0])).toContain(EVENT.exportId);
    expect(JSON.stringify(wheres[0])).toContain(EVENT.orgId);
  });

  it("refuses without retrying when the deployment has no attester key — an unsigned export is not the bundle the capability promises", async () => {
    delete process.env[ATTESTER_KEY_ENV];

    await expect(handler({ event: { data: EVENT }, step })).rejects.toThrow(
      /no attester key/,
    );
    expect(mocks.putBundle).not.toHaveBeenCalled();
    // The row was still marked building, so Audit shows the attempt.
    expect(steps).toEqual(["mark-building", "build-and-upload"]);
  });

  it("refuses without retrying when the run is not in the export's workspace", async () => {
    mocks.resolveRunRecord.mockResolvedValue(null);

    await expect(handler({ event: { data: EVENT }, step })).rejects.toThrow(
      /not in the export's workspace/,
    );
    expect(mocks.readSealedSegments).not.toHaveBeenCalled();
    expect(mocks.putBundle).not.toHaveBeenCalled();
  });

  it("refuses without retrying when the run has no sealed attempt — there is nothing to attest", async () => {
    mocks.readSealedSegments.mockResolvedValue([]);

    await expect(handler({ event: { data: EVENT }, step })).rejects.toThrow(
      /no sealed attempt/,
    );
    expect(mocks.buildRunExportBundle).not.toHaveBeenCalled();
    expect(mocks.putBundle).not.toHaveBeenCalled();
  });
});

describe("evidence.run-export on failure", () => {
  it("marks the row failed with the reason, so Audit never shows an eternally building job", async () => {
    await onFailure({
      event: {
        data: { event: { data: EVENT }, error: { message: "upload refused" } },
      },
      step,
    });

    expect(steps).toEqual(["mark-export-failed"]);
    expect(updates[0]?.values).toMatchObject({
      status: "failed",
      error: "upload refused",
    });
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it("records a non-object failure as its string form rather than dropping the reason", async () => {
    await onFailure({
      event: { data: { event: { data: EVENT }, error: "boom" } },
      step,
    });

    expect(updates[0]?.values).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });

  it("records an absent failure rather than writing an empty reason", async () => {
    await onFailure({ event: { data: { event: { data: EVENT } } }, step });

    expect(updates[0]?.values).toMatchObject({ error: "unknown error" });
  });

  it("writes nothing when the failure carries no row to mark", async () => {
    await onFailure({
      event: { data: { event: { data: { orgId: EVENT.orgId } } } },
      step,
    });

    expect(steps).toEqual([]);
    expect(updates).toEqual([]);
  });
});
