import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  decrypt: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  projectSnapshotToGraph: vi.fn().mockResolvedValue(undefined),
  pruneLegacySourceDetail: vi.fn().mockResolvedValue(undefined),
  fetchMock: vi.fn(),
}));

// sql tag that exposes the joined query text so the tx mock can route on it.
const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
  text: strings.join("?"),
  values,
});
Object.assign(sqlTag, { raw: (s: string) => ({ text: s, values: [] }) });

vi.mock("drizzle-orm", () => ({ sql: sqlTag }));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  withTenantDb: mocks.withTenantDb,
}));

vi.mock("@oxagen/crypto", () => ({
  decrypt: mocks.decrypt,
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
}));

vi.mock("@oxagen/ontology", () => ({
  projectSnapshotToGraph: mocks.projectSnapshotToGraph,
  pruneLegacySourceDetail: mocks.pruneLegacySourceDetail,
}));

vi.stubGlobal("fetch", mocks.fetchMock);

const lib = await import("../github-projection");

// ── tx.execute router ──────────────────────────────────────────────────────────
type Rows = Array<Record<string, unknown>>;
type Responder = (text: string) => Rows;

/** Build a fake drizzle tx whose execute() routes on the SQL text. Records the
 *  ordered list of matched SQL fragments so ordering can be asserted. */
function makeTx(responder: Responder, order: string[]) {
  return {
    execute: vi.fn(async (query: { text: string }) => {
      order.push(query.text);
      return responder(query.text);
    }),
  };
}

function ok(body: unknown, headers: Record<string, string> = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectSnapshotToGraph.mockResolvedValue(undefined);
  mocks.pruneLegacySourceDetail.mockResolvedValue(undefined);
});

// ── deriveScopes ────────────────────────────────────────────────────────────────
describe("deriveScopes", () => {
  it("maps a package-manifest directory to a 'package' scope named by its last segment", () => {
    const { scopes, scopeKeyByPath } = lib.deriveScopes([
      "packages/billing/package.json",
      "packages/billing/src/charge.ts",
      "packages/billing/src/refund.ts",
    ]);
    const billing = scopes.find((s) => s.scopeKey === "packages/billing");
    expect(billing).toMatchObject({
      scopeKey: "packages/billing",
      kind: "package",
      displayName: "billing",
      fileCount: 3,
    });
    expect(scopeKeyByPath["packages/billing/src/charge.ts"]).toBe(
      "packages/billing",
    );
  });

  it("binds a nested-package file to the NEAREST package (longest-prefix wins)", () => {
    const { scopeKeyByPath, scopes } = lib.deriveScopes([
      "packages/app/package.json",
      "packages/app/src/index.ts",
      "packages/app/plugins/auth/package.json",
      "packages/app/plugins/auth/src/login.ts",
    ]);
    expect(scopeKeyByPath["packages/app/src/index.ts"]).toBe("packages/app");
    expect(scopeKeyByPath["packages/app/plugins/auth/src/login.ts"]).toBe(
      "packages/app/plugins/auth",
    );
    const keys = scopes.map((s) => s.scopeKey);
    expect(keys).toContain("packages/app");
    expect(keys).toContain("packages/app/plugins/auth");
  });

  it("maps files with no package to their top-level dir as a 'path' scope", () => {
    const { scopes, scopeKeyByPath } = lib.deriveScopes([
      "docs/intro.md",
      "docs/guide.md",
      "src/main.ts",
    ]);
    expect(scopeKeyByPath["docs/intro.md"]).toBe("docs");
    const docs = scopes.find((s) => s.scopeKey === "docs");
    expect(docs).toMatchObject({ kind: "path", displayName: "docs", fileCount: 2 });
    expect(scopes.find((s) => s.scopeKey === "src")).toMatchObject({
      kind: "path",
      fileCount: 1,
    });
  });

  it("maps root-level files to scope_key '.' with displayName '(root)'", () => {
    const { scopes, scopeKeyByPath } = lib.deriveScopes([
      "README.md",
      "turbo.json",
      "src/x.ts",
    ]);
    expect(scopeKeyByPath["README.md"]).toBe(".");
    const root = scopes.find((s) => s.scopeKey === ".");
    expect(root).toMatchObject({ kind: "path", displayName: "(root)", fileCount: 2 });
  });

  it("treats a repo-root manifest as the '.' package that absorbs unscoped files", () => {
    const { scopes, scopeKeyByPath } = lib.deriveScopes([
      "package.json",
      "src/index.ts",
      "packages/db/package.json",
      "packages/db/schema.ts",
    ]);
    // Root package absorbs src/index.ts (no nearer package); packages/db wins for its files.
    expect(scopeKeyByPath["src/index.ts"]).toBe(".");
    expect(scopeKeyByPath["packages/db/schema.ts"]).toBe("packages/db");
    const root = scopes.find((s) => s.scopeKey === ".");
    expect(root).toMatchObject({ kind: "package", displayName: "(root)" });
  });

  it("is deterministic: scopes are sorted by scopeKey regardless of input order", () => {
    const a = lib.deriveScopes(["b/x.ts", "a/y.ts", "c/z.ts"]);
    const b = lib.deriveScopes(["c/z.ts", "a/y.ts", "b/x.ts"]);
    expect(a.scopes.map((s) => s.scopeKey)).toEqual(["a", "b", "c"]);
    expect(a.scopes).toEqual(b.scopes);
  });
});

// ── isParseableFile ─────────────────────────────────────────────────────────────
describe("isParseableFile", () => {
  it("accepts allowed-extension blobs and rejects excluded/zero/tree entries", () => {
    expect(lib.isParseableFile({ path: "src/a.ts", type: "blob", size: 10 })).toBe(true);
    expect(lib.isParseableFile({ path: "README.md", type: "blob", size: 10 })).toBe(true);
    expect(lib.isParseableFile({ path: "node_modules/x.ts", type: "blob", size: 10 })).toBe(false);
    expect(lib.isParseableFile({ path: "src/a.ts", type: "blob", size: 0 })).toBe(false);
    expect(lib.isParseableFile({ path: "src", type: "tree", size: 10 })).toBe(false);
    expect(lib.isParseableFile({ path: "bin/data.bin", type: "blob", size: 10 })).toBe(false);
  });
});

// ── resolveCanonicalHead ────────────────────────────────────────────────────────
describe("resolveCanonicalHead", () => {
  it("resolves ref → commit → tree/parents, NEVER fetching a tree by branch name", async () => {
    mocks.fetchMock.mockImplementation((url: string) => {
      if (url.includes("/git/ref/heads/main"))
        return ok({ object: { sha: "commit-abc", type: "commit" } });
      if (url.includes("/git/commits/commit-abc"))
        return ok({ sha: "commit-abc", tree: { sha: "tree-xyz" }, parents: [{ sha: "parent-1" }] });
      throw new Error(`unexpected url ${url}`);
    });

    const head = await lib.resolveCanonicalHead("tok", "acme", "api", "main");
    expect(head).toEqual({ commitSha: "commit-abc", treeSha: "tree-xyz", parentShas: ["parent-1"] });
    const urls = mocks.fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/git/trees/main"))).toBe(false);
    expect(urls.some((u) => u.includes("/git/ref/heads/main"))).toBe(true);
  });

  it("strips a refs/heads/ prefix from a full ref", async () => {
    mocks.fetchMock.mockImplementation((url: string) => {
      if (url.includes("/git/ref/heads/trunk"))
        return ok({ object: { sha: "c1" } });
      return ok({ tree: { sha: "t1" }, parents: [] });
    });
    const head = await lib.resolveCanonicalHead("tok", "acme", "api", "refs/heads/trunk");
    expect(head.commitSha).toBe("c1");
    expect(head.parentShas).toEqual([]);
  });

  it("throws when the ref API is non-OK", async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(lib.resolveCanonicalHead("t", "a", "r", "main")).rejects.toThrow(/git\/ref\/heads\/main returned 404/);
  });
});

// ── fetchTreeBySha ──────────────────────────────────────────────────────────────
describe("fetchTreeBySha", () => {
  it("fetches by the immutable tree SHA (not a branch) and surfaces truncation", async () => {
    mocks.fetchMock.mockImplementation((url: string) => {
      expect(url).toContain("/git/trees/tree-xyz");
      expect(url).toContain("recursive=1");
      return ok({ tree: [{ path: "a.ts", type: "blob", sha: "s", size: 1 }], truncated: true });
    });
    const res = await lib.fetchTreeBySha("tok", "acme", "api", "tree-xyz");
    expect(res.truncated).toBe(true);
    expect(res.entries).toHaveLength(1);
  });
});

// ── fetchConnectionAccessToken ──────────────────────────────────────────────────
describe("fetchConnectionAccessToken", () => {
  it("decrypts the connection's stored oauth token", async () => {
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        execute: vi.fn().mockResolvedValue([
          { access_token_enc: { keyId: "k1", ciphertext: Buffer.from("x").toString("base64") } },
        ]),
      }),
    );
    mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({ keyId: "k1", adapter: {} });
    mocks.decrypt.mockResolvedValue(Buffer.from("ghp_tok"));

    const tok = await lib.fetchConnectionAccessToken("conn-1", "11111111-1111-1111-1111-111111111111");
    expect(tok).toBe("ghp_tok");
  });

  it("throws when the connection has no token", async () => {
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ execute: vi.fn().mockResolvedValue([]) }),
    );
    await expect(lib.fetchConnectionAccessToken("c", "o")).rejects.toThrow(/no oauth token/);
  });
});

// ── stageGeneration ─────────────────────────────────────────────────────────────
describe("stageGeneration", () => {
  const BASE = {
    orgId: "org-1",
    workspaceId: "ws-1",
    provider: "github",
    providerRepoId: "42",
    owner: "acme",
    name: "api",
    installationId: "inst-1",
    sourceConnectionId: "conn-1",
    defaultRef: "refs/heads/main",
    commitSha: "commit-abc",
    treeSha: "tree-xyz",
    parentShas: ["p1"],
    observedHeadSha: "commit-abc",
    filesTotal: 3,
    truncated: false,
    parserVersion: "1",
    scopes: [
      { scopeKey: "packages/billing", kind: "package" as const, displayName: "billing", domainSlug: null, fileCount: 2 },
      { scopeKey: ".", kind: "path" as const, displayName: "(root)", domainSlug: null, fileCount: 1 },
    ],
  };

  it("stages a fresh generation: inserts repo/snapshot/generation/scopes and returns ids", async () => {
    let scopeN = 0;
    const order: string[] = [];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        makeTx((text) => {
          if (text.includes("INSERT INTO ingestion.code_repositories")) return [{ id: "repo-1" }];
          if (text.includes("INSERT INTO ingestion.repository_snapshots")) return [{ id: "snap-1" }];
          if (text.includes("INSERT INTO ingestion.projection_generations")) return [{ id: "gen-1" }];
          if (text.includes("INSERT INTO ingestion.code_scopes")) return [{ id: `scope-${++scopeN}` }];
          return [];
        }, order),
      ),
    );

    const res = await lib.stageGeneration(BASE);
    expect(res).toMatchObject({
      repositoryId: "repo-1",
      snapshotId: "snap-1",
      generationId: "gen-1",
      alreadyExists: false,
      commitSha: "commit-abc",
      treeSha: "tree-xyz",
    });
    expect(res.codeScopeIdByKey).toEqual({ "packages/billing": "scope-1", ".": "scope-2" });
    // Two code-scope inserts (one per scope).
    expect(order.filter((t) => t.includes("INSERT INTO ingestion.code_scopes"))).toHaveLength(2);
  });

  it("dedupes by after-sha: a conflicting generation returns alreadyExists WITHOUT re-inserting scopes", async () => {
    const order: string[] = [];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        makeTx((text) => {
          if (text.includes("INSERT INTO ingestion.code_repositories")) return [{ id: "repo-1" }];
          if (text.includes("INSERT INTO ingestion.repository_snapshots")) return []; // snapshot already existed
          if (text.includes("SELECT id FROM ingestion.repository_snapshots")) return [{ id: "snap-existing" }];
          if (text.includes("INSERT INTO ingestion.projection_generations")) return []; // generation conflict
          if (text.includes("SELECT id FROM ingestion.projection_generations")) return [{ id: "gen-existing" }];
          if (text.includes("SELECT id, scope_key FROM ingestion.code_scopes"))
            return [{ id: "scope-a", scope_key: "packages/billing" }];
          return [];
        }, order),
      ),
    );

    const res = await lib.stageGeneration(BASE);
    expect(res).toMatchObject({
      repositoryId: "repo-1",
      snapshotId: "snap-existing",
      generationId: "gen-existing",
      alreadyExists: true,
    });
    expect(res.codeScopeIdByKey).toEqual({ "packages/billing": "scope-a" });
    // No code-scope INSERT on the dedupe path.
    expect(order.some((t) => t.includes("INSERT INTO ingestion.code_scopes"))).toBe(false);
  });
});

// ── activateGenerationIfComplete ────────────────────────────────────────────────
describe("activateGenerationIfComplete", () => {
  /** Wire withTenantDb to a router over a mutable generation-state fixture. */
  function wire(state: {
    status: string;
    filesTotal: number;
    filesProcessed: number;
    filesSkipped: number;
    recheckStatus?: string; // status seen inside the flip tx (defaults to `status`)
  }, order: string[]) {
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        makeTx((text) => {
          // Gate read (selects repository_id, snapshot_id).
          if (
            text.includes("FROM ingestion.projection_generations") &&
            text.includes("repository_id, snapshot_id")
          ) {
            return [
              {
                status: state.status,
                files_total: state.filesTotal,
                files_processed: state.filesProcessed,
                files_skipped: state.filesSkipped,
                repository_id: "repo-1",
                snapshot_id: "snap-1",
              },
            ];
          }
          if (text.includes("SELECT provider_repo_id, owner, name"))
            return [{ provider_repo_id: "42", owner: "acme", name: "api" }];
          if (text.includes("SELECT commit_sha, tree_sha"))
            return [{ commit_sha: "commit-abc", tree_sha: "tree-xyz" }];
          if (text.includes("SELECT scope_key, kind, display_name"))
            return [{ scope_key: "packages/billing", kind: "package", display_name: "billing", domain_slug: null, file_count: 2 }];
          // Flip-tx gate recheck (status/files, no repository_id).
          if (
            text.includes("FROM ingestion.projection_generations") &&
            text.includes("status, files_total, files_processed, files_skipped") &&
            !text.includes("repository_id")
          ) {
            return [
              {
                status: state.recheckStatus ?? state.status,
                files_total: state.filesTotal,
                files_processed: state.filesProcessed,
                files_skipped: state.filesSkipped,
              },
            ];
          }
          return [];
        }, order),
      ),
    );
  }

  it("does NOT activate or project when the generation is incomplete", async () => {
    const order: string[] = [];
    wire({ status: "building", filesTotal: 5, filesProcessed: 3, filesSkipped: 1 }, order);
    const res = await lib.activateGenerationIfComplete("gen-1");
    expect(res.activated).toBe(false);
    expect(mocks.projectSnapshotToGraph).not.toHaveBeenCalled();
    expect(mocks.pruneLegacySourceDetail).not.toHaveBeenCalled();
    // No flip UPDATE issued.
    expect(order.some((t) => t.includes("UPDATE ingestion.projection_generations"))).toBe(false);
  });

  it("activates when complete: projects the snapshot, supersedes others, advances projected_head_sha", async () => {
    const order: string[] = [];
    wire({ status: "building", filesTotal: 4, filesProcessed: 3, filesSkipped: 1 }, order);

    const res = await lib.activateGenerationIfComplete("gen-1");
    expect(res).toMatchObject({ activated: true, generationId: "gen-1", repositoryId: "repo-1", commitSha: "commit-abc" });

    // Neo4j projection ran with the snapshot topology.
    expect(mocks.projectSnapshotToGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: { providerRepoId: "42", owner: "acme", name: "api" },
        snapshot: { commitSha: "commit-abc", treeSha: "tree-xyz" },
        scopes: [expect.objectContaining({ scopeKey: "packages/billing", fileCount: 2 })],
      }),
    );
    expect(mocks.pruneLegacySourceDetail).toHaveBeenCalledWith({ owner: "acme", repo: "api" });

    // Supersede + activate + advance-head all issued.
    const joined = order.join("\n");
    expect(joined).toContain("SET status = 'superseded'");
    expect(joined).toContain("SET status = 'active'");
    expect(joined).toContain("SET projected_head_sha =");
    // Repo row locked FOR UPDATE before the flip.
    expect(joined).toContain("FOR UPDATE");
  });

  it("runs the idempotent Neo4j projection BEFORE the atomic flip (retry-safety ordering)", async () => {
    const order: string[] = [];
    // Record when the projection ran relative to the SQL order.
    let projectedAtSqlIndex = -1;
    mocks.projectSnapshotToGraph.mockImplementation(async () => {
      projectedAtSqlIndex = order.length;
    });
    wire({ status: "building", filesTotal: 2, filesProcessed: 2, filesSkipped: 0 }, order);

    await lib.activateGenerationIfComplete("gen-1");

    const activateSqlIndex = order.findIndex((t) => t.includes("SET status = 'active'"));
    expect(projectedAtSqlIndex).toBeGreaterThanOrEqual(0);
    expect(activateSqlIndex).toBeGreaterThan(projectedAtSqlIndex);
  });

  it("stands down (activated:false) when a concurrent completer already flipped the generation", async () => {
    const order: string[] = [];
    // Cheap gate sees 'building'; the flip-tx recheck sees 'active' (someone won).
    wire({ status: "building", filesTotal: 2, filesProcessed: 2, filesSkipped: 0, recheckStatus: "active" }, order);

    const res = await lib.activateGenerationIfComplete("gen-1");
    expect(res.activated).toBe(false);
    // Projection still ran (idempotent) but no activate UPDATE was issued.
    expect(mocks.projectSnapshotToGraph).toHaveBeenCalled();
    expect(order.some((t) => t.includes("SET status = 'active'"))).toBe(false);
  });
});
