// Unit tests for ingestion.github-commit-files.
//
// The function receives "ingestion/github.commit-files" (fanned out from
// ingestion-github-initial-sync for the most recent N commits), fetches the
// per-commit file list from GitHub, MERGEs a :Commit {:GraphNode} node and
// (:Commit)-[:MODIFIED]->(:SourceFile) edges in Neo4j.
//
// We assert:
//   - Correct event registration and concurrency config.
//   - :Commit naturalKey format: github:{connectionId}:{owner}/{repo}:{sha}
//   - MERGE is called with the right Cypher params (sha, message, committedAt …)
//   - Files that match an existing :SourceFile produce an edge (edgesWritten++)
//   - Files with no :SourceFile match are skipped (filesSkipped++), not errored
//   - A 404 commit response returns { skipped: true, reason: "commit_not_found" }
//   - session.close() is always called (even on error)

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ── hoisted stubs ──────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  decrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  runInTenantScope: vi.fn(),
  sessionRun: vi.fn(),
  sessionClose: vi.fn(),
  scopedSession: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fetch: vi.fn(),
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("drizzle-orm", () => ({
  sql: vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals })),
}));

vi.mock("@oxagen/crypto", () => ({
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
  decrypt: mocks.decrypt,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// ── Capture handler via createFunction ────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};
type HandlerFn = (ctx: {
  event: { data: unknown };
  step: StepCtx;
}) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;
let capturedOpts: { id: string; concurrency: { limit: number; key: string } } | null = null;
let capturedTrigger: { event: string } | null = null;

mocks.createFunction.mockImplementation(
  (
    opts: typeof capturedOpts,
    trigger: typeof capturedTrigger,
    handler: HandlerFn,
  ) => {
    capturedOpts = opts;
    capturedTrigger = trigger;
    capturedHandler = handler;
    return [{ id: opts?.id }];
  },
);

// Import the module — this triggers the createFunction call.
await import("./ingestion.github-commit-files");

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_EVENT_DATA = {
  connectionId: "conn-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  owner: "acme",
  repo: "platform",
  sha: "abc1234def5678",
};

/** Minimal valid GitHub commit detail response. */
const COMMIT_DETAIL = {
  sha: "abc1234def5678",
  commit: {
    message: "fix: resolve race condition in scheduler\n\nBody paragraph here.",
    author: {
      name: "Mac Anderson",
      date: "2026-06-26T12:00:00Z",
    },
  },
  files: [
    { filename: "src/scheduler.ts", status: "modified", additions: 10, deletions: 3 },
    { filename: "package-lock.json", status: "modified", additions: 2, deletions: 2 },
  ],
};

// ── beforeEach resets ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: token resolution succeeds.
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: vi.fn().mockResolvedValue([
          {
            access_token_enc: {
              keyId: "k1",
              ciphertext: Buffer.from("token").toString("base64"),
            },
          },
        ]),
      }),
  );
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    keyId: "k1",
    adapter: {},
  });
  mocks.decrypt.mockResolvedValue(Buffer.from("gh-token-abc"));

  // Default: GitHub fetch returns the commit detail.
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => COMMIT_DETAIL,
  });
  vi.stubGlobal("fetch", mocks.fetch);

  // Default: session returns empty records (no matching SourceFile) for edge MERGEs.
  mocks.sessionRun.mockResolvedValue({ records: [] });
  mocks.sessionClose.mockResolvedValue(undefined);
  mocks.scopedSession.mockReturnValue({
    run: mocks.sessionRun,
    close: mocks.sessionClose,
  });

  // runInTenantScope passes through to fn().
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
});

// ── Registration tests ────────────────────────────────────────────────────────

describe("registration", () => {
  it("registers on ingestion/github.commit-files event", () => {
    expect(capturedTrigger?.event).toBe("ingestion/github.commit-files");
  });

  it("uses id ingestion-github-commit-files", () => {
    expect(capturedOpts?.id).toBe("ingestion-github-commit-files");
  });

  it("limits concurrency to 5 per orgId", () => {
    expect(capturedOpts?.concurrency.limit).toBe(5);
    expect(capturedOpts?.concurrency.key).toBe("event.data.orgId");
  });
});

// ── :Commit node MERGE ────────────────────────────────────────────────────────

describe(":Commit MERGE correctness", () => {
  it("calls session.run with the correct :Commit naturalKey", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    // First session.run call is the :Commit MERGE.
    const firstCall = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    const params = firstCall[1];

    expect(params["naturalKey"]).toBe(
      `github:conn-1:acme/platform:${BASE_EVENT_DATA.sha}`,
    );
    expect(params["orgId"]).toBe("org-1");
    expect(params["sha"]).toBe(BASE_EVENT_DATA.sha);
    // label and is_system are Cypher literals in the query, not params
    expect(params["workspaceId"]).toBe("ws-1");
    expect(params["connectionId"]).toBe("conn-1");
    // Cypher query must contain the :GraphNode label and Commit label
    const query = firstCall[0];
    expect(query).toContain(":GraphNode");
    expect(query).toContain("'Commit'");
    expect(query).toContain("is_system   = true");
  });

  it("stores commit message, authorName, committedAt on the :Commit node", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    const firstCall = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    const params = firstCall[1];

    expect(params["message"]).toBe(COMMIT_DETAIL.commit.message);
    expect(params["authorName"]).toBe("Mac Anderson");
    expect(params["committedAt"]).toBe("2026-06-26T12:00:00Z");
  });

  it("sets displayName to 7-char sha + first line of message", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    const firstCall = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    const params = firstCall[1];

    // sha.slice(0, 7) = "abc1234"
    expect(params["displayName"]).toBe(
      "abc1234 fix: resolve race condition in scheduler",
    );
  });

  it("encodes properties as a JSON string", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    const firstCall = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    const props = JSON.parse(firstCall[1]["properties"] as string) as Record<string, unknown>;
    expect(props["sha"]).toBe(BASE_EVENT_DATA.sha);
    expect(props["authorName"]).toBe("Mac Anderson");
  });
});

// ── :MODIFIED edge writing ────────────────────────────────────────────────────

describe(":MODIFIED edges", () => {
  it("writes an edge for files whose :SourceFile exists and skips those that don't", async () => {
    // First session.run = :Commit MERGE (returns empty, we don't care).
    // Second call = src/scheduler.ts edge MERGE → file IS indexed → return a record.
    // Third call = package-lock.json edge MERGE → NOT indexed → return empty.
    (mocks.sessionRun as Mock)
      .mockResolvedValueOnce({ records: [] }) // :Commit MERGE
      .mockResolvedValueOnce({ records: [{ get: (_k: string) => "r" }] }) // src/scheduler.ts matched
      .mockResolvedValueOnce({ records: [] }); // package-lock.json not matched

    const result = (await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    })) as {
      edgesWritten: number;
      filesSkipped: number;
      fileCount: number;
      sha: string;
    };

    expect(result.edgesWritten).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.fileCount).toBe(2);
    expect(result.sha).toBe(BASE_EVENT_DATA.sha);
  });

  it("builds the correct :SourceFile naturalKey for the edge MERGE", async () => {
    (mocks.sessionRun as Mock)
      .mockResolvedValueOnce({ records: [] }) // :Commit MERGE
      .mockResolvedValueOnce({ records: [{ get: (_k: string) => "r" }] }); // first file

    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    // Second call = edge MERGE for src/scheduler.ts
    const edgeCall = mocks.sessionRun.mock.calls[1] as [string, Record<string, unknown>];
    const params = edgeCall[1];

    expect(params["commitNaturalKey"]).toBe(
      `github:conn-1:acme/platform:${BASE_EVENT_DATA.sha}`,
    );
    expect(params["fileNaturalKey"]).toBe(
      "github:conn-1:acme/platform:src/scheduler.ts",
    );
    expect(params["status"]).toBe("modified");
    expect(params["additions"]).toBe(10);
    expect(params["deletions"]).toBe(3);
    expect(params["orgId"]).toBe("org-1");
  });

  it("writes edgesWritten:0 when no :SourceFile nodes exist", async () => {
    // All session.run calls return empty records.
    mocks.sessionRun.mockResolvedValue({ records: [] });

    const result = (await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    })) as { edgesWritten: number; filesSkipped: number };

    expect(result.edgesWritten).toBe(0);
    expect(result.filesSkipped).toBe(2); // both files unmatched
  });
});

// ── 404 handling ──────────────────────────────────────────────────────────────

describe("commit 404", () => {
  it("returns skipped:true without writing to Neo4j when GitHub returns 404", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 404 });

    const result = (await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    })) as { skipped: boolean; reason: string; edgesWritten: number };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("commit_not_found");
    expect(result.edgesWritten).toBe(0);
    // session.run must NOT have been called.
    expect(mocks.sessionRun).not.toHaveBeenCalled();
  });

  it("logs a warning for 404 responses", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 404 });

    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sha: BASE_EVENT_DATA.sha }),
      "ingestion-github-commit-files: commit 404, skipping",
    );
  });
});

// ── session.close always called ───────────────────────────────────────────────

describe("session cleanup", () => {
  it("calls session.close() on the happy path", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() });
    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });

  it("calls session.close() even when session.run throws", async () => {
    (mocks.sessionRun as Mock).mockRejectedValueOnce(new Error("Neo4j unavailable"));

    await expect(
      capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() }),
    ).rejects.toThrow("Neo4j unavailable");

    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });
});

// ── missing files array ───────────────────────────────────────────────────────

describe("missing files list", () => {
  it("logs a warning and returns edgesWritten:0 when commit has no files array (> 300 file merge commit)", async () => {
    const detailNoFiles = {
      sha: BASE_EVENT_DATA.sha,
      commit: COMMIT_DETAIL.commit,
      // files intentionally absent
    };
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => detailNoFiles,
    });

    const result = (await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    })) as { edgesWritten: number; filesSkipped: number; fileCount: number };

    expect(result.edgesWritten).toBe(0);
    expect(result.fileCount).toBe(0);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sha: BASE_EVENT_DATA.sha }),
      "ingestion-github-commit-files: commit files list absent (> 300 file merge commit?), skipping file edges",
    );
  });
});

// ── commitNaturalKey in return value ─────────────────────────────────────────

describe("return value", () => {
  it("includes commitNaturalKey in the result", async () => {
    const result = (await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    })) as { commitNaturalKey: string; skipped: boolean };

    expect(result.commitNaturalKey).toBe(
      `github:conn-1:acme/platform:${BASE_EVENT_DATA.sha}`,
    );
    expect(result.skipped).toBe(false);
  });
});
