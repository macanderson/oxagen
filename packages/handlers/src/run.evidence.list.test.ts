/**
 * Unit tests for the list_run_evidence handler.
 *
 * Coverage targets:
 *   - maps manifest rows to summaries with change/frame counts from child tables
 *   - keyset pagination: limit+1 fetch → nextCursor set when a further page exists
 *   - no next page → nextCursor null
 *   - empty page → no child-count queries, empty result
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { runEvidenceListHandler } from "./run.evidence.list";
import { TEST_CTX } from "./test-utils/fixtures";

function makeRow(i: number, createdAt: string) {
  return {
    internalId: `man-${i}`,
    publicId: `rem_${i}`,
    runId: `run_${i}`,
    attemptId: null as string | null,
    evidenceAuthority: "client_attested",
    manifestDigest: "f".repeat(64),
    createdAt: new Date(createdAt),
  };
}

/**
 * Drive the three sequential selects the list handler runs:
 *   1. main page query   → orderBy → limit
 *   2. change-count query → groupBy
 *   3. frame-count query  → groupBy
 */
function makeListTx(opts: {
  pageRows: unknown[];
  changeCounts?: { manifestId: string; n: number }[];
  frameCounts?: { manifestId: string; n: number }[];
}) {
  const select = vi
    .fn()
    .mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve(opts.pageRows) }),
        }),
      }),
    }))
    .mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          groupBy: () => Promise.resolve(opts.changeCounts ?? []),
        }),
      }),
    }))
    .mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          groupBy: () => Promise.resolve(opts.frameCounts ?? []),
        }),
      }),
    }));
  return { select };
}

function runWithTx(tx: unknown) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
}

describe("list_run_evidence handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps rows to summaries with change/frame counts from child tables", async () => {
    const tx = makeListTx({
      pageRows: [makeRow(1, "2026-07-20T00:00:00.000Z")],
      changeCounts: [{ manifestId: "man-1", n: 3 }],
      frameCounts: [{ manifestId: "man-1", n: 2 }],
    });
    runWithTx(tx);

    const result = await runEvidenceListHandler({ limit: 25 }, TEST_CTX);

    expect(result.manifests).toHaveLength(1);
    expect(result.manifests[0]?.id).toBe("rem_1");
    expect(result.manifests[0]?.changeCount).toBe(3);
    expect(result.manifests[0]?.frameCount).toBe(2);
    expect(result.manifests[0]?.evidenceAuthority).toBe("client_attested");
    expect(result.nextCursor).toBeNull();
  });

  it("sets nextCursor when limit+1 rows come back", async () => {
    // limit 2 → handler fetches 3; a 3rd row signals a further page.
    const tx = makeListTx({
      pageRows: [
        makeRow(1, "2026-07-20T00:00:03.000Z"),
        makeRow(2, "2026-07-20T00:00:02.000Z"),
        makeRow(3, "2026-07-20T00:00:01.000Z"),
      ],
    });
    runWithTx(tx);

    const result = await runEvidenceListHandler({ limit: 2 }, TEST_CTX);

    expect(result.manifests).toHaveLength(2);
    // nextCursor is the created_at of the LAST returned (2nd) row.
    expect(result.nextCursor).toBe("2026-07-20T00:00:02.000Z");
    // rows with no child evidence default to zero counts.
    expect(result.manifests[0]?.changeCount).toBe(0);
    expect(result.manifests[1]?.frameCount).toBe(0);
  });

  it("returns an empty page without querying child counts", async () => {
    const tx = makeListTx({ pageRows: [] });
    runWithTx(tx);

    const result = await runEvidenceListHandler({ limit: 25 }, TEST_CTX);

    expect(result.manifests).toEqual([]);
    expect(result.nextCursor).toBeNull();
    // only the main query ran; no groupBy count queries.
    expect((tx.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
