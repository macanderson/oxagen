import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  runInTenantScope: vi.fn(),
  upsertSourceConnectionMeta: vi.fn().mockResolvedValue(undefined),
  fetchConnectionAccessToken: vi.fn(),
  resolveCanonicalHead: vi.fn(),
  fetchTreeBySha: vi.fn(),
  stageGeneration: vi.fn(),
  fetchMock: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
    sendEvent: (name: string, payload: unknown) => Promise<void>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;
let capturedCreateFunctionArgs: unknown[] | null = null;

mocks.createFunction.mockImplementation(
  (opts: unknown, trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    capturedCreateFunctionArgs = [opts, trigger, handler];
    return {};
  },
);

vi.mock("../../inngest", () => ({
  inngest: { createFunction: mocks.createFunction },
}));

const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
Object.assign(sqlTag, { mapWith: () => sqlTag, raw: () => sqlTag });

vi.mock("@oxagen/database", () => ({ withSystemDb: mocks.withSystemDb }));
vi.mock("drizzle-orm", () => ({ sql: sqlTag }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));
vi.mock("@oxagen/ingestion/mutations", () => ({
  upsertSourceConnectionMeta: mocks.upsertSourceConnectionMeta,
}));

// Partial mock of the shared lib: mock the I/O functions, keep the PURE ones
// (deriveScopes, isParseableFile, EXCLUDED_PREFIXES, MAX_FILES,
// PROJECTION_PARSER_VERSION) real so scope derivation is exercised end-to-end.
vi.mock("../../lib/github-projection", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/github-projection")>();
  return {
    ...actual,
    fetchConnectionAccessToken: mocks.fetchConnectionAccessToken,
    resolveCanonicalHead: mocks.resolveCanonicalHead,
    fetchTreeBySha: mocks.fetchTreeBySha,
    stageGeneration: mocks.stageGeneration,
  };
});

vi.mock("../../logger", () => ({
  logger: { info: mocks.loggerInfo, debug: vi.fn(), error: vi.fn(), warn: mocks.loggerWarn },
}));

vi.stubGlobal("fetch", mocks.fetchMock);

await import("../ingestion.github-initial-sync");

// ── Fixtures ────────────────────────────────────────────────────────────────
const BASE_EVENT = {
  connectionId: "conn-gh-1",
  orgId: "org-gh-1",
  workspaceId: "ws-gh-1",
  owner: "acme",
  repo: "api",
  syncDepthDays: 90,
};

const REPO_META = {
  id: 42,
  name: "api",
  full_name: "acme/api",
  default_branch: "trunk", // deliberately not "main"
  owner: { login: "acme" },
};

const HEAD = { commitSha: "commit-abc", treeSha: "tree-xyz", parentShas: ["p1"] };

const TREE_ENTRIES = [
  { path: "packages/billing/package.json", type: "blob", sha: "s-manifest", size: 100 },
  { path: "packages/billing/charge.ts", type: "blob", sha: "s-charge", size: 200 },
  { path: "src/auth.ts", type: "blob", sha: "s-auth", size: 300 },
  { path: "README.md", type: "blob", sha: "s-readme", size: 50 },
  { path: "node_modules/lodash/index.js", type: "blob", sha: "s-lodash", size: 100 },
  { path: "packages/billing", type: "tree", sha: "s-tree" },
];

const PULLS = [{ number: 1, title: "x" }, { number: 2, title: "y" }];
const ISSUES_RAW = [
  { number: 10, title: "bug" },
  { number: 2, title: "y", pull_request: { url: "x" } },
];
const RELEASES = [{ id: 99, tag_name: "v1" }];
const COMMITS = [{ sha: "deadbeef", commit: { message: "init", author: { date: "2026-01-01" } } }];

const STAGED = {
  repositoryId: "repo-1",
  snapshotId: "snap-1",
  generationId: "gen-1",
  alreadyExists: false,
  codeScopeIdByKey: { ".": "cs-root", "packages/billing": "cs-billing", src: "cs-src" },
  commitSha: HEAD.commitSha,
  treeSha: HEAD.treeSha,
};

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function routedFetch() {
  return (url: string) => {
    if (url.includes("/pulls")) return ok(PULLS);
    if (url.includes("/issues")) return ok(ISSUES_RAW);
    if (url.includes("/releases")) return ok(RELEASES);
    if (url.includes("/commits")) return ok(COMMITS);
    return ok(REPO_META); // GET /repos/{owner}/{repo}
  };
}

function setupDefaultMocks(): void {
  mocks.fetchConnectionAccessToken.mockResolvedValue("ghp_tok");
  mocks.resolveCanonicalHead.mockResolvedValue(HEAD);
  mocks.fetchTreeBySha.mockResolvedValue({ entries: TREE_ENTRIES, truncated: false });
  mocks.stageGeneration.mockResolvedValue(STAGED);
  mocks.runInTenantScope.mockImplementation((_s: unknown, fn: () => unknown) => fn());
  mocks.fetchMock.mockImplementation(routedFetch());
}

function makeStep(): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function allEventsFrom(sendEvent: ReturnType<typeof vi.fn>) {
  return sendEvent.mock.calls.flatMap((c) => {
    const payload = c[1];
    return (Array.isArray(payload) ? payload : [payload]) as Array<{
      name: string;
      data: Record<string, unknown>;
    }>;
  });
}

function entitiesOfType(sendEvent: ReturnType<typeof vi.fn>, t: string) {
  return allEventsFrom(sendEvent).filter(
    (e) => e.name === "ingestion/entity.received" && e.data?.["sourceRecordType"] === t,
  );
}

function parseFiles(sendEvent: ReturnType<typeof vi.fn>) {
  return allEventsFrom(sendEvent).filter((e) => e.name === "ingestion/github.parse-file");
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("ingestion.github-initial-sync (SHA-pinned projection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("registers a createFunction with the correct id and trigger", () => {
    const [opts, trigger] = capturedCreateFunctionArgs as [Record<string, unknown>, Record<string, unknown>];
    expect(opts).toMatchObject({ id: "ingestion-github-initial-sync", retries: 3 });
    expect(trigger).toMatchObject({ event: "ingestion/github.initial-sync" });
  });

  it("throws NonRetriableError when owner/repo missing", async () => {
    await expect(
      capturedHandler!({ event: { data: { ...BASE_EVENT, owner: "" } }, step: makeStep() }),
    ).rejects.toMatchObject({ name: "NonRetriableError" });
  });

  it("resolves the token and canonical head for the real default branch", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT }, step: makeStep() });
    expect(mocks.fetchConnectionAccessToken).toHaveBeenCalledWith("conn-gh-1", "org-gh-1");
    expect(mocks.resolveCanonicalHead).toHaveBeenCalledWith("ghp_tok", "acme", "api", "trunk");
  });

  it("fetches the tree BY ITS SHA, never by the branch name", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT }, step: makeStep() });
    expect(mocks.fetchTreeBySha).toHaveBeenCalledWith("ghp_tok", "acme", "api", "tree-xyz");
    // The branch name must never appear as the tree argument.
    for (const call of mocks.fetchTreeBySha.mock.calls) {
      expect(call[3]).not.toBe("trunk");
    }
  });

  it("pins the commit backfill to the resolved commit SHA, not the branch", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT }, step: makeStep() });
    const commitCalls = mocks.fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/commits?"));
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(commitCalls[0]).toContain("sha=commit-abc");
    expect(commitCalls[0]).not.toContain("sha=trunk");
  });

  it("stages a generation with providerRepoId, filesTotal=parseable count, and derived scopes", async () => {
    await capturedHandler!({ event: { data: BASE_EVENT }, step: makeStep() });
    expect(mocks.stageGeneration).toHaveBeenCalledTimes(1);
    const arg = mocks.stageGeneration.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      provider: "github",
      providerRepoId: "42",
      owner: "acme",
      name: "api",
      defaultRef: "refs/heads/trunk",
      commitSha: "commit-abc",
      treeSha: "tree-xyz",
      parentShas: ["p1"],
      filesTotal: 3, // charge.ts, auth.ts, README.md (package.json/.js/node_modules excluded)
      sourceConnectionId: "conn-gh-1",
      installationId: null,
    });
    // Derived scopes: root path ".", the billing package, and the src path.
    const scopeKeys = (arg["scopes"] as Array<{ scopeKey: string }>).map((s) => s.scopeKey).sort();
    expect(scopeKeys).toEqual([".", "packages/billing", "src"]);
    const billing = (arg["scopes"] as Array<{ scopeKey: string; kind: string; fileCount: number }>).find(
      (s) => s.scopeKey === "packages/billing",
    );
    expect(billing).toMatchObject({ kind: "package", fileCount: 2 });
  });

  it("fans out one extended parse-file per parseable file with its generation + scope binding", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    const pf = parseFiles(sendEvent);
    expect(pf).toHaveLength(3);
    for (const ev of pf) {
      expect(ev.data).toMatchObject({
        connectionId: "conn-gh-1",
        owner: "acme",
        repo: "api",
        repositoryId: "repo-1",
        generationId: "gen-1",
        commitSha: "commit-abc",
        treeSha: "tree-xyz",
      });
      expect(typeof ev.data["scopeKey"]).toBe("string");
      expect(typeof ev.data["codeScopeId"]).toBe("string");
    }
    // charge.ts binds to the billing package scope + its scope id.
    const charge = pf.find((e) => e.data["path"] === "packages/billing/charge.ts")!;
    expect(charge.data).toMatchObject({ scopeKey: "packages/billing", codeScopeId: "cs-billing" });
    const auth = pf.find((e) => e.data["path"] === "src/auth.ts")!;
    expect(auth.data).toMatchObject({ scopeKey: "src", codeScopeId: "cs-src" });
  });

  it("still backfills repository/pull_request/issue/release/commit entities", async () => {
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(entitiesOfType(sendEvent, "repository")).toHaveLength(1);
    expect(entitiesOfType(sendEvent, "pull_request")).toHaveLength(2);
    expect(entitiesOfType(sendEvent, "issue")).toHaveLength(1); // PR filtered out
    expect(entitiesOfType(sendEvent, "release")).toHaveLength(1);
    const commits = entitiesOfType(sendEvent, "commit");
    expect(commits).toHaveLength(1);
    expect((commits[0]!.data["payload"] as Record<string, unknown>)["git_branch"]).toBe("trunk");
  });

  it("skips re-fan-out and infer-domains when the generation already exists (dedupe-by-after-sha)", async () => {
    mocks.stageGeneration.mockResolvedValue({ ...STAGED, alreadyExists: true });
    const step = makeStep();
    const sendEvent = step.sendEvent as ReturnType<typeof vi.fn>;
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(parseFiles(sendEvent)).toHaveLength(0);
    expect(allEventsFrom(sendEvent).some((e) => e.name === "ingestion/github.infer-domains")).toBe(false);
    // Entity backfill still ran (idempotent upserts).
    expect(entitiesOfType(sendEvent, "repository")).toHaveLength(1);
  });

  it("returns the commit/tree/generation identity and counts", async () => {
    const result = (await capturedHandler!({ event: { data: BASE_EVENT }, step: makeStep() })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      connectionId: "conn-gh-1",
      owner: "acme",
      repo: "api",
      commitSha: "commit-abc",
      treeSha: "tree-xyz",
      generationId: "gen-1",
      alreadyExists: false,
      fileCount: 3,
      entityCount: 6, // 1 repo + 2 PR + 1 issue + 1 release + 1 commit
    });
  });
});
