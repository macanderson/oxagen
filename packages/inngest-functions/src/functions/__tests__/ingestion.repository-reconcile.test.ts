import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  fetchConnectionAccessToken: vi.fn(),
  resolveCanonicalHead: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

type HandlerCtx = {
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
  runInTenantScope: vi.fn((_s: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@oxagen/ontology", () => ({
  projectSnapshotToGraph: vi.fn(),
  pruneLegacySourceDetail: vi.fn(),
  removeCanonicalFiles: vi.fn(),
}));
vi.mock("@oxagen/crypto", () => ({
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("../../lib/github-projection", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/github-projection")>();
  return {
    ...actual,
    fetchConnectionAccessToken: mocks.fetchConnectionAccessToken,
    resolveCanonicalHead: mocks.resolveCanonicalHead,
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

await import("../ingestion.repository-reconcile");

// ── Fixtures ─────────────────────────────────────────────────────────────────
/** One ingestion.code_repositories row as the cron's candidate query reads it.
 *  The nullable columns are load-bearing — an OAuth-connected repository has no
 *  installation id, and an unprojected one has no head. */
interface CodeRepositoryRow {
  id: string;
  org_id: string;
  workspace_id: string;
  provider_repo_id: string;
  owner: string;
  name: string;
  installation_id: string | null;
  source_connection_id: string;
  default_ref: string;
  projected_head_sha: string | null;
}

const REPO_ROW: CodeRepositoryRow = {
  id: "repo-1",
  org_id: "org-1",
  workspace_id: "ws-1",
  provider_repo_id: "42",
  owner: "acme",
  name: "api",
  installation_id: "inst-9",
  source_connection_id: "conn-1",
  default_ref: "refs/heads/trunk",
  projected_head_sha: "sha-projected",
};

let candidateRows: CodeRepositoryRow[];
let executed: Array<{ text: string; values: unknown[] }>;

function sqlTextOf(q: unknown): string {
  return Array.from((q as { strings?: readonly string[] }).strings ?? []).join(
    " ",
  );
}

function setupDefaultMocks(): void {
  executed = [];
  candidateRows = [REPO_ROW];

  mocks.withSystemDb.mockImplementation(
    async (
      fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => unknown,
    ) =>
      fn({
        execute: async (q: unknown) => {
          executed.push({
            text: sqlTextOf(q),
            values: (q as { values: unknown[] }).values,
          });
          return candidateRows;
        },
      }),
  );
  mocks.fetchConnectionAccessToken.mockResolvedValue("ghp_tok");
  mocks.resolveCanonicalHead.mockResolvedValue({
    commitSha: "sha-drifted",
    treeSha: "tree-1",
    parentShas: [],
  });
}

function makeStep(): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function eventsFrom(sendEvent: ReturnType<typeof vi.fn>) {
  return sendEvent.mock.calls.flatMap((c) => {
    const payload = c[1];
    return (Array.isArray(payload) ? payload : [payload]) as Array<{
      name: string;
      data: Record<string, unknown>;
    }>;
  });
}

async function run() {
  const step = makeStep();
  const result = (await capturedHandler!({ step })) as Record<string, unknown>;
  return { result, step };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("ingestion.repository-reconcile (hourly ref reconciliation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("registers as an hourly cron", () => {
    const [opts, trigger] = capturedCreateFunctionArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({
      id: "ingestion-repository-reconcile",
      retries: 2,
    });
    expect(trigger).toEqual({ cron: "0 * * * *" });
  });

  it("only considers repositories with a live connection and no build in flight", async () => {
    await run();
    const { text } = executed[0]!;
    expect(text).toMatch(/FROM\s+ingestion\.code_repositories/i);
    expect(text).toMatch(/sc\.status\s*=\s*'connected'/);
    expect(text).toMatch(/sc\.deleted_at IS NULL/);
    // The 'building' guard is evaluated in SQL so a mid-build repo is never
    // even fetched from GitHub.
    expect(text).toMatch(/NOT EXISTS/i);
    expect(text).toMatch(/g\.status\s*=\s*'building'/);
  });

  it("emits nothing when there are no candidate repositories", async () => {
    candidateRows = [];
    const { result, step } = await run();

    expect(result).toEqual({ inspected: 0, drifted: 0 });
    expect(mocks.resolveCanonicalHead).not.toHaveBeenCalled();
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  it("emits nothing when the authoritative head already matches projected_head_sha", async () => {
    mocks.resolveCanonicalHead.mockResolvedValue({
      commitSha: "sha-projected",
      treeSha: "tree-1",
      parentShas: [],
    });
    const { result, step } = await run();

    expect(mocks.resolveCanonicalHead).toHaveBeenCalledWith(
      "ghp_tok",
      "acme",
      "api",
      "refs/heads/trunk",
    );
    expect(result).toEqual({ inspected: 1, drifted: 0 });
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  it("emits a synthetic ref-updated when the head has drifted past the projection", async () => {
    const { result, step } = await run();

    expect(result).toEqual({ inspected: 1, drifted: 1 });
    const events = eventsFrom(step.sendEvent as ReturnType<typeof vi.fn>);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("ingestion/repository.ref-updated");
    expect(events[0]!.data).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      connectionId: "conn-1",
      installationId: "inst-9",
      providerRepoId: "42",
      owner: "acme",
      repo: "api",
      ref: "refs/heads/trunk",
      // The projected head is the delta base — a repo a few commits behind
      // still reconciles via `compare` rather than a whole-tree rebuild.
      beforeSha: "sha-projected",
      afterSha: "sha-drifted",
      forced: false,
      deleted: false,
    });
    expect(typeof events[0]!.data["observedAt"]).toBe("string");
  });

  it("keys the delivery id on repository + target head so hourly repeats dedupe", async () => {
    const { step } = await run();
    const events = eventsFrom(step.sendEvent as ReturnType<typeof vi.fn>);
    expect(events[0]!.data["deliveryId"]).toBe("reconcile:42:sha-drifted");
  });

  it("skips a repository whose head cannot be resolved instead of failing the tick", async () => {
    candidateRows = [
      REPO_ROW,
      { ...REPO_ROW, id: "repo-2", provider_repo_id: "43" },
    ];
    mocks.resolveCanonicalHead
      .mockRejectedValueOnce(new Error("401 bad credentials"))
      .mockResolvedValueOnce({
        commitSha: "sha-drifted",
        treeSha: "t",
        parentShas: [],
      });

    const { result, step } = await run();

    expect(mocks.loggerWarn).toHaveBeenCalled();
    expect(result).toEqual({ inspected: 2, drifted: 1 });
    const events = eventsFrom(step.sendEvent as ReturnType<typeof vi.fn>);
    expect(events).toHaveLength(1);
    expect(events[0]!.data["providerRepoId"]).toBe("43");
  });

  it("resolves each repository's token from its own governed connection", async () => {
    await run();
    expect(mocks.fetchConnectionAccessToken).toHaveBeenCalledWith(
      "conn-1",
      "org-1",
    );
  });

  it("forwards a null installation id verbatim rather than an empty-string placeholder", async () => {
    // "" is not NULL, so it would beat stageGeneration's COALESCE downstream
    // and blank the repository's stored installation id.
    candidateRows = [{ ...REPO_ROW, installation_id: null }];
    const { step } = await run();
    expect(
      eventsFrom(step.sendEvent as ReturnType<typeof vi.fn>)[0]!.data,
    ).toMatchObject({ installationId: null });
  });
});
