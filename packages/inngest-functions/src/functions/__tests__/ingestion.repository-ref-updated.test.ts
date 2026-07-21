import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  removeCanonicalFiles: vi.fn().mockResolvedValue(undefined),
  fetchConnectionAccessToken: vi.fn(),
  resolveCanonicalHead: vi.fn(),
  fetchTreeBySha: vi.fn(),
  fetchCompare: vi.fn(),
  stageGeneration: vi.fn(),
  activateGenerationIfComplete: vi.fn(),
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

const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
  strings,
  values,
});
Object.assign(sqlTag, {
  mapWith: () => sqlTag,
  raw: () => sqlTag,
  param: (v: unknown) => v,
});

vi.mock("drizzle-orm", () => ({ sql: sqlTag }));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));
// The real lib imports these at module load (partial mock below keeps it real).
vi.mock("@oxagen/ontology", () => ({
  removeCanonicalFiles: mocks.removeCanonicalFiles,
  projectSnapshotToGraph: vi.fn(),
  pruneLegacySourceDetail: vi.fn(),
}));
vi.mock("@oxagen/crypto", () => ({
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  decrypt: vi.fn(),
}));

// Partial mock: every I/O function is stubbed, every PURE one
// (deriveScopes, isParseableFile, classifyCompareFiles, EXCLUDED_PREFIXES,
// MAX_FILES, PROJECTION_PARSER_VERSION) stays real so scope derivation and
// compare classification are exercised end-to-end.
vi.mock("../../lib/github-projection", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/github-projection")>();
  return {
    ...actual,
    fetchConnectionAccessToken: mocks.fetchConnectionAccessToken,
    resolveCanonicalHead: mocks.resolveCanonicalHead,
    fetchTreeBySha: mocks.fetchTreeBySha,
    fetchCompare: mocks.fetchCompare,
    stageGeneration: mocks.stageGeneration,
    activateGenerationIfComplete: mocks.activateGenerationIfComplete,
  };
});

vi.mock("../../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    debug: vi.fn(),
    error: vi.fn(),
    warn: mocks.loggerWarn,
  },
}));

await import("../ingestion.repository-ref-updated");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const DEFAULT_REF = "refs/heads/trunk";

/** Mirrors the "ingestion/repository.ref-updated" payload in inngest.ts — the
 *  nullable SHAs are load-bearing (branch create/delete send no commit). */
interface RefUpdatedData {
  orgId: string;
  workspaceId: string;
  connectionId: string;
  installationId: string;
  providerRepoId: string;
  owner: string;
  repo: string;
  ref: string;
  beforeSha: string | null;
  afterSha: string | null;
  forced: boolean;
  deleted: boolean;
  deliveryId: string;
  observedAt: string;
}

const BASE_EVENT: RefUpdatedData = {
  orgId: "org-1",
  workspaceId: "ws-1",
  connectionId: "conn-1",
  installationId: "inst-9",
  providerRepoId: "42",
  owner: "acme",
  repo: "api",
  ref: DEFAULT_REF,
  beforeSha: "sha-before",
  afterSha: "sha-after",
  forced: false,
  deleted: false,
  deliveryId: "delivery-guid-1",
  observedAt: "2026-07-21T10:00:00.000Z",
};

const HEAD = {
  commitSha: "sha-after",
  treeSha: "tree-xyz",
  parentShas: ["sha-before"],
};

const TREE_ENTRIES = [
  {
    path: "packages/billing/package.json",
    type: "blob",
    sha: "s-manifest",
    size: 100,
  },
  {
    path: "packages/billing/charge.ts",
    type: "blob",
    sha: "s-charge",
    size: 200,
  },
  { path: "src/auth.ts", type: "blob", sha: "s-auth", size: 300 },
  { path: "README.md", type: "blob", sha: "s-readme", size: 50 },
  {
    path: "node_modules/lodash/index.js",
    type: "blob",
    sha: "s-lodash",
    size: 100,
  },
  { path: "packages/billing", type: "tree", sha: "s-tree" },
];

const COMPARE_FILES = [
  {
    filename: "packages/billing/charge.ts",
    status: "modified",
    sha: "s-charge-2",
  },
  { filename: "src/legacy.ts", status: "removed" },
  {
    filename: "README.md",
    status: "renamed",
    sha: "s-readme-2",
    previous_filename: "READ.md",
  },
  {
    filename: "node_modules/lodash/index.js",
    status: "modified",
    sha: "s-lodash-2",
  },
];

const STAGED = {
  repositoryId: "repo-1",
  snapshotId: "snap-1",
  generationId: "gen-1",
  alreadyExists: false,
  codeScopeIdByKey: {
    ".": "cs-root",
    "packages/billing": "cs-billing",
    src: "cs-src",
  },
  commitSha: HEAD.commitSha,
  treeSha: HEAD.treeSha,
};

/** Mutable fake-Postgres state driving the withTenantDb mock. */
type DbState = {
  repoRows: Array<{
    id: string;
    default_ref: string;
    projected_head_sha: string | null;
  }>;
  observationInserted: boolean;
  executed: Array<{ text: string; values: unknown[] }>;
};
let db: DbState;

function sqlTextOf(q: unknown): string {
  const strings = (q as { strings?: readonly string[] }).strings ?? [];
  return Array.from(strings).join(" ");
}

function setupDefaultMocks(): void {
  db = {
    repoRows: [
      {
        id: "repo-1",
        default_ref: DEFAULT_REF,
        projected_head_sha: "sha-before",
      },
    ],
    observationInserted: true,
    executed: [],
  };

  mocks.withTenantDb.mockImplementation(
    async (
      fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => unknown,
    ) =>
      fn({
        execute: async (q: unknown) => {
          const text = sqlTextOf(q);
          db.executed.push({
            text,
            values: (q as { values: unknown[] }).values,
          });
          if (/SELECT[\s\S]*FROM\s+ingestion\.code_repositories/i.test(text)) {
            return db.repoRows;
          }
          if (
            /INSERT INTO ingestion\.repository_ref_observations/i.test(text)
          ) {
            return db.observationInserted ? [{ id: "obs-1" }] : [];
          }
          return [];
        },
      }),
  );

  mocks.runInTenantScope.mockImplementation((_s: unknown, fn: () => unknown) =>
    fn(),
  );
  mocks.fetchConnectionAccessToken.mockResolvedValue("ghp_tok");
  mocks.resolveCanonicalHead.mockResolvedValue(HEAD);
  mocks.fetchTreeBySha.mockResolvedValue({
    entries: TREE_ENTRIES,
    truncated: false,
  });
  mocks.fetchCompare.mockResolvedValue(COMPARE_FILES);
  mocks.stageGeneration.mockResolvedValue(STAGED);
  mocks.activateGenerationIfComplete.mockResolvedValue({
    activated: true,
    generationId: "gen-1",
  });
  mocks.removeCanonicalFiles.mockResolvedValue(undefined);
}

function makeStep(): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function parseFileEvents(sendEvent: ReturnType<typeof vi.fn>) {
  return sendEvent.mock.calls
    .flatMap((c) => {
      const payload = c[1];
      return (Array.isArray(payload) ? payload : [payload]) as Array<{
        name: string;
        data: Record<string, unknown>;
      }>;
    })
    .filter((e) => e.name === "ingestion/github.parse-file");
}

async function run(overrides: Partial<RefUpdatedData> = {}) {
  const step = makeStep();
  const result = await capturedHandler!({
    event: { data: { ...BASE_EVENT, ...overrides } },
    step,
  });
  return { result: result as Record<string, unknown>, step };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("ingestion.repository-ref-updated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("registers with the ref-updated trigger and serializes per repository", () => {
    const [opts, trigger] = capturedCreateFunctionArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({
      id: "ingestion-repository-ref-updated",
      retries: 3,
    });
    // limit is PER key value — 1 means two pushes to one repo never overlap.
    expect(opts["concurrency"]).toEqual({
      limit: 1,
      key: "event.data.providerRepoId",
    });
    expect(trigger).toMatchObject({
      event: "ingestion/repository.ref-updated",
    });
  });

  it("stops when no governed repository row exists yet", async () => {
    db.repoRows = [];
    const { result, step } = await run();
    expect(result).toEqual({ stopped: "no_repository" });
    expect(mocks.fetchConnectionAccessToken).not.toHaveBeenCalled();
    expect(mocks.stageGeneration).not.toHaveBeenCalled();
    expect(
      parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>),
    ).toHaveLength(0);
  });

  it("records the observation with the delivery id and event observedAt", async () => {
    await run();
    const insert = db.executed.find((e) =>
      /INSERT INTO ingestion\.repository_ref_observations/i.test(e.text),
    )!;
    expect(insert.text).toContain("ON CONFLICT (delivery_id) DO NOTHING");
    expect(insert.values).toContain("delivery-guid-1");
    expect(insert.values).toContain("2026-07-21T10:00:00.000Z");
  });

  it("dedupes by delivery id: a redelivered webhook is a complete no-op", async () => {
    db.observationInserted = false; // ON CONFLICT DO NOTHING returned no row
    const { result, step } = await run();

    expect(result).toEqual({ stopped: "duplicate_delivery" });
    expect(mocks.fetchConnectionAccessToken).not.toHaveBeenCalled();
    expect(mocks.resolveCanonicalHead).not.toHaveBeenCalled();
    expect(mocks.stageGeneration).not.toHaveBeenCalled();
    expect(mocks.removeCanonicalFiles).not.toHaveBeenCalled();
    expect(
      parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>),
    ).toHaveLength(0);
  });

  it("advances observed_head_sha on the canonical ref", async () => {
    await run();
    const update = db.executed.find((e) =>
      /UPDATE ingestion\.code_repositories/i.test(e.text),
    );
    expect(update).toBeDefined();
    expect(update!.text).toContain("observed_head_sha");
    expect(update!.values).toContain("sha-after");
  });

  it("never mutates shared topology for a NONCANONICAL ref", async () => {
    const { result, step } = await run({ ref: "refs/heads/feature-x" });

    expect(result).toEqual({ stopped: "noncanonical_ref" });
    expect(mocks.stageGeneration).not.toHaveBeenCalled();
    expect(mocks.removeCanonicalFiles).not.toHaveBeenCalled();
    expect(
      parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>),
    ).toHaveLength(0);
    // A feature branch must not move the canonical observed head either.
    expect(
      db.executed.some((e) =>
        /UPDATE ingestion\.code_repositories/i.test(e.text),
      ),
    ).toBe(false);
  });

  it("never mutates shared topology for a DELETED ref", async () => {
    const { result, step } = await run({ deleted: true, afterSha: null });

    expect(result).toEqual({ stopped: "noncanonical_ref" });
    expect(mocks.stageGeneration).not.toHaveBeenCalled();
    expect(
      parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>),
    ).toHaveLength(0);
    expect(
      db.executed.some((e) =>
        /UPDATE ingestion\.code_repositories/i.test(e.text),
      ),
    ).toBe(false);
  });

  it("re-fetches the authoritative head instead of trusting the webhook's afterSha", async () => {
    // GitHub already advanced past the pushed SHA — the projection must follow
    // the authoritative head, not the (stale) webhook payload.
    mocks.resolveCanonicalHead.mockResolvedValue({
      commitSha: "sha-newer",
      treeSha: "tree-newer",
      parentShas: [],
    });
    await run();

    expect(mocks.resolveCanonicalHead).toHaveBeenCalledWith(
      "ghp_tok",
      "acme",
      "api",
      DEFAULT_REF,
    );
    expect(mocks.fetchTreeBySha).toHaveBeenCalledWith(
      "ghp_tok",
      "acme",
      "api",
      "tree-newer",
    );
    expect(mocks.stageGeneration.mock.calls[0]![0]).toMatchObject({
      commitSha: "sha-newer",
      treeSha: "tree-newer",
    });
  });

  describe("delta branch", () => {
    it("compares from the projected head and fans out ONLY changed files", async () => {
      const { result, step } = await run();

      expect(mocks.fetchCompare).toHaveBeenCalledWith(
        "ghp_tok",
        "acme",
        "api",
        "sha-before",
        "sha-after",
      );
      expect(result).toMatchObject({
        mode: "delta",
        generationId: "gen-1",
        fannedOut: 2,
      });

      const pf = parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>);
      expect(pf.map((e) => e.data["path"]).sort()).toEqual([
        "README.md",
        "packages/billing/charge.ts",
      ]);
      // node_modules and the removed path never fan out.
      expect(
        pf.some((e) => String(e.data["path"]).startsWith("node_modules/")),
      ).toBe(false);
      // Head-of-range blob SHAs, generation binding and scope binding ride along.
      const charge = pf.find(
        (e) => e.data["path"] === "packages/billing/charge.ts",
      )!;
      expect(charge.data).toMatchObject({
        sha: "s-charge-2",
        generationId: "gen-1",
        repositoryId: "repo-1",
        commitSha: "sha-after",
        treeSha: "tree-xyz",
        scopeKey: "packages/billing",
        codeScopeId: "cs-billing",
      });
      // files_total is the delta count, not the whole tree.
      expect(mocks.stageGeneration.mock.calls[0]![0]).toMatchObject({
        filesTotal: 2,
      });
    });

    it("retires the canonical nodes of deleted files AND the old path of a rename", async () => {
      const { result } = await run();

      expect(mocks.removeCanonicalFiles).toHaveBeenCalledTimes(1);
      const arg = mocks.removeCanonicalFiles.mock.calls[0]![0] as {
        owner: string;
        repo: string;
        paths: string[];
      };
      expect(arg.owner).toBe("acme");
      expect(arg.repo).toBe("api");
      expect(arg.paths.sort()).toEqual(["READ.md", "src/legacy.ts"]);
      expect(result).toMatchObject({ removed: 2 });
    });
  });

  describe("full reconcile branch", () => {
    it("falls back to the whole tree on a FORCED push", async () => {
      const { result, step } = await run({ forced: true });

      expect(mocks.fetchCompare).not.toHaveBeenCalled();
      expect(mocks.removeCanonicalFiles).not.toHaveBeenCalled();
      expect(result).toMatchObject({ mode: "full", fannedOut: 3 });

      const pf = parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>);
      expect(pf.map((e) => e.data["path"]).sort()).toEqual([
        "README.md",
        "packages/billing/charge.ts",
        "src/auth.ts",
      ]);
    });

    it("falls back to the whole tree when the projected head is not the push base", async () => {
      db.repoRows = [
        {
          id: "repo-1",
          default_ref: DEFAULT_REF,
          projected_head_sha: "sha-way-behind",
        },
      ];
      const { result } = await run();

      expect(mocks.fetchCompare).not.toHaveBeenCalled();
      expect(result).toMatchObject({ mode: "full", fannedOut: 3 });
    });

    it("falls back to the whole tree when nothing has been projected yet", async () => {
      db.repoRows = [
        { id: "repo-1", default_ref: DEFAULT_REF, projected_head_sha: null },
      ];
      const { result } = await run();

      expect(mocks.fetchCompare).not.toHaveBeenCalled();
      expect(result).toMatchObject({ mode: "full", fannedOut: 3 });
    });
  });

  it("activates immediately when the generation has zero parseable files", async () => {
    // Deletions-only push: no file will ever report done, so the completion gate
    // has to be driven directly or the generation wedges in 'building'.
    mocks.fetchCompare.mockResolvedValue([
      { filename: "src/legacy.ts", status: "removed" },
    ]);
    const { result, step } = await run();

    expect(mocks.stageGeneration.mock.calls[0]![0]).toMatchObject({
      filesTotal: 0,
    });
    expect(
      parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>),
    ).toHaveLength(0);
    expect(mocks.activateGenerationIfComplete).toHaveBeenCalledWith("gen-1");
    expect(result).toMatchObject({ mode: "delta", fannedOut: 0, removed: 1 });
  });

  it("does not activate directly when files were fanned out", async () => {
    await run();
    expect(mocks.activateGenerationIfComplete).not.toHaveBeenCalled();
  });

  it("stops without re-fanning out when the snapshot is already staged", async () => {
    mocks.stageGeneration.mockResolvedValue({ ...STAGED, alreadyExists: true });
    const { result, step } = await run();

    expect(result).toMatchObject({
      stopped: "already_staged",
      generationId: "gen-1",
    });
    expect(
      parseFileEvents(step.sendEvent as ReturnType<typeof vi.fn>),
    ).toHaveLength(0);
    expect(mocks.removeCanonicalFiles).not.toHaveBeenCalled();
    expect(mocks.activateGenerationIfComplete).not.toHaveBeenCalled();
  });

  it("stages provider_observed with the repository's discovered default ref", async () => {
    await run();
    expect(mocks.stageGeneration.mock.calls[0]![0]).toMatchObject({
      provider: "github",
      providerRepoId: "42",
      owner: "acme",
      name: "api",
      installationId: "inst-9",
      sourceConnectionId: "conn-1",
      defaultRef: DEFAULT_REF,
      observedHeadSha: "sha-after",
      snapshotSource: "provider_observed",
      truncated: false,
    });
  });
});
