/**
 * Unit tests for the submit_run_evidence handler.
 *
 * Coverage targets:
 *   - happy path: fresh insert stamps client_attested, writes normalized
 *     change + frame child rows in the same tx, returns deduplicated:false
 *   - dedupe: onConflictDoNothing returns no row → existing manifest returned
 *     with deduplicated:true and NO child rows written (immutable ledger)
 *   - authority is ALWAYS client_attested, even when a caller injects
 *     evidenceAuthority (launch invariant 4)
 *   - tenant scoping: org_id/workspace_id on the manifest AND every child row
 *     come from ctx
 *   - manifest_digest is a deterministic function of the input
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { runEvidenceSubmitHandler } from "./run.evidence.submit";
import { schema } from "@oxagen/database";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

const BASE_INPUT = {
  runId: "run_1",
  attemptId: "attempt_1",
  principals: {
    initiatingPrincipalId: "prn_init",
    agentPrincipalId: "prn_agent",
  },
  agentVersionId: "av_1",
  authorizationSnapshotId: "auth_1",
  localCheckoutSnapshot: {
    baseCommitSha: "a".repeat(40),
    headCommitSha: "b".repeat(40),
    dirtyPatchDigest: "dirty",
  },
  changes: [
    {
      pathLocator: "packages/billing/index.ts",
      changeKind: "modified" as const,
      beforeDigest: "before",
      afterDigest: "after",
    },
  ],
  context: {
    compiledFrameManifestDigest: "cfd",
    frames: [
      {
        providerId: "cgp",
        frameId: "f1",
        canonicalContentDigest: "digest",
        retentionMode: "hash_only" as const,
        tokenCost: 128,
      },
    ],
  },
  commits: [],
  pullRequestReceipts: [],
  toolReceipts: [],
  approvalReceipts: [],
  verificationReceipts: [],
  artifactDigests: [] as string[],
};

/** Captures the rows written to each table and drives the insert/select chain. */
function makeTx(opts: { insertedRows: unknown[]; existingRows?: unknown[] }) {
  const captured: {
    manifestValues?: Record<string, unknown>;
    changeRows?: Record<string, unknown>[];
    frameRows?: Record<string, unknown>[];
  } = {};
  const tx = {
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        if (table === schema.runEvidenceManifests)
          captured.manifestValues = rows as Record<string, unknown>;
        if (table === schema.runEvidenceChanges)
          captured.changeRows = rows as Record<string, unknown>[];
        if (table === schema.runContextFrames)
          captured.frameRows = rows as Record<string, unknown>[];
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(opts.insertedRows),
          }),
          // thenable: child inserts `await tx.insert(...).values(...)`
          then: (resolve: (v: unknown) => void) => resolve(undefined),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(opts.existingRows ?? []),
        }),
      }),
    }),
  };
  return { tx, captured };
}

function runWithTx(tx: unknown) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
}

describe("submit_run_evidence — happy path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps client_attested, writes child rows, returns deduplicated:false", async () => {
    const { tx, captured } = makeTx({
      insertedRows: [{ id: "man-uuid-1", publicId: "rem_pub1" }],
    });
    runWithTx(tx);

    const result = await runEvidenceSubmitHandler(BASE_INPUT, TEST_CTX);

    expect(result.deduplicated).toBe(false);
    expect(result.manifestId).toBe("rem_pub1");
    expect(result.manifestDigest).toMatch(/^[0-9a-f]{64}$/);

    // authority hard-stamped
    expect(captured.manifestValues?.evidenceAuthority).toBe("client_attested");
    // typed local-checkout columns projected from the snapshot
    expect(captured.manifestValues?.baseCommitSha).toBe("a".repeat(40));
    expect(captured.manifestValues?.manifestDigest).toBe(result.manifestDigest);
    // full input retained as payload
    expect(captured.manifestValues?.payload).toBe(BASE_INPUT);

    // child change row normalized and linked to the manifest uuid
    expect(captured.changeRows).toHaveLength(1);
    expect(captured.changeRows?.[0]?.manifestId).toBe("man-uuid-1");
    expect(captured.changeRows?.[0]?.pathLocator).toBe(
      "packages/billing/index.ts",
    );
    expect(captured.changeRows?.[0]?.changeKind).toBe("modified");

    // child frame row normalized and linked
    expect(captured.frameRows).toHaveLength(1);
    expect(captured.frameRows?.[0]?.manifestId).toBe("man-uuid-1");
    expect(captured.frameRows?.[0]?.retentionMode).toBe("hash_only");
  });

  it("does not write child rows when there are no changes or frames", async () => {
    const { tx, captured } = makeTx({
      insertedRows: [{ id: "man-uuid-2", publicId: "rem_pub2" }],
    });
    runWithTx(tx);

    await runEvidenceSubmitHandler(
      {
        ...BASE_INPUT,
        changes: [],
        context: { compiledFrameManifestDigest: "x", frames: [] },
      },
      TEST_CTX,
    );

    expect(captured.changeRows).toBeUndefined();
    expect(captured.frameRows).toBeUndefined();
  });
});

describe("submit_run_evidence — dedupe (immutable ledger)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the existing manifest with deduplicated:true and writes no child rows", async () => {
    const { tx, captured } = makeTx({
      insertedRows: [], // onConflictDoNothing → conflict, no row returned
      existingRows: [{ publicId: "rem_existing" }],
    });
    runWithTx(tx);

    const result = await runEvidenceSubmitHandler(BASE_INPUT, TEST_CTX);

    expect(result.deduplicated).toBe(true);
    expect(result.manifestId).toBe("rem_existing");
    expect(result.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    // ledger never rewritten → no child inserts on a dedupe
    expect(captured.changeRows).toBeUndefined();
    expect(captured.frameRows).toBeUndefined();
  });
});

describe("submit_run_evidence — launch invariant 4 (authority)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores a caller-injected evidenceAuthority and stamps client_attested", async () => {
    const { tx, captured } = makeTx({
      insertedRows: [{ id: "man-uuid-3", publicId: "rem_pub3" }],
    });
    runWithTx(tx);

    // A hostile caller tries to author runner_observed evidence.
    const hostile = {
      ...BASE_INPUT,
      evidenceAuthority: "runner_observed",
    } as unknown as typeof BASE_INPUT;

    await runEvidenceSubmitHandler(hostile, TEST_CTX);

    expect(captured.manifestValues?.evidenceAuthority).toBe("client_attested");
  });
});

describe("submit_run_evidence — tenant scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps org_id/workspace_id from ctx on the manifest and every child row", async () => {
    const { tx, captured } = makeTx({
      insertedRows: [{ id: "man-uuid-4", publicId: "rem_pub4" }],
    });
    runWithTx(tx);

    const ctx: CapabilityContext = makeCTX({
      orgId: "org_z",
      workspaceId: "ws_z",
      userId: "u_z",
    });
    await runEvidenceSubmitHandler(BASE_INPUT, ctx);

    expect(captured.manifestValues?.orgId).toBe("org_z");
    expect(captured.manifestValues?.workspaceId).toBe("ws_z");
    expect(captured.manifestValues?.createdByUserId).toBe("u_z");
    expect(captured.changeRows?.[0]?.orgId).toBe("org_z");
    expect(captured.changeRows?.[0]?.workspaceId).toBe("ws_z");
    expect(captured.frameRows?.[0]?.orgId).toBe("org_z");
    expect(captured.frameRows?.[0]?.workspaceId).toBe("ws_z");
  });
});

describe("submit_run_evidence — deterministic digest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("computes the same manifest_digest for identical input", async () => {
    const first = makeTx({
      insertedRows: [{ id: "m1", publicId: "rem_a" }],
    });
    runWithTx(first.tx);
    const a = await runEvidenceSubmitHandler(BASE_INPUT, TEST_CTX);

    const second = makeTx({
      insertedRows: [{ id: "m2", publicId: "rem_b" }],
    });
    runWithTx(second.tx);
    const b = await runEvidenceSubmitHandler(BASE_INPUT, TEST_CTX);

    expect(a.manifestDigest).toBe(b.manifestDigest);
  });
});
