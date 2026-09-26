import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutId,
  prLinkOf,
  WORK_CONTEXT_CAP,
  workDigest,
  type WorkContextRow,
  type WorkDiffRow,
} from "./lib/run-work";
import { readWorkPullRequests, type WorkPrDeps } from "./lib/run-work-prs";
import { createRunWorkGetHandler, type RunWorkDeps } from "./run.work.get";
import type { TachoSessionColumns } from "./run.list";
import {
  ctx,
  memoryStores,
  tachoSession,
  OTHER_WORKSPACE,
  roleTx,
} from "./run.test-support";
const role = vi.hoisted(() => ({ current: "Owner" as string | null }));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withOrgDb: (fn: (tx: ReturnType<typeof roleTx>) => unknown) =>
    fn(roleTx(role.current)),
  withTenantDb: (fn: (tx: ReturnType<typeof roleTx>) => unknown) =>
    fn(roleTx(role.current)),
}));
beforeEach(() => {
  role.current = "Owner";
});
const RUN_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
function setup(session: Partial<TachoSessionColumns> = {}) {
  const stores = memoryStores(
    [],
    [tachoSession({ publicId: RUN_ID, session })],
  );
  const deps: RunWorkDeps = {
    queries: stores.queries,
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    store: {
      getRunByPublicId: async () => null,
      readAttemptEventsSince: async () => [],
    },
    tachoFrames: async () => [],
    contexts: vi.fn().mockResolvedValue([
      {
        path: "/repo",
        branch: "main",
        head: "abc",
        remote: "",
        repository: "",
        first_seq: 0,
        last_seq: 7,
      },
    ]),
    diffs: vi.fn().mockResolvedValue([]),
    subagents: vi.fn().mockResolvedValue([
      {
        id: "a0182b6cd3a21d284",
        type: "Explore",
        first_seq: 3,
        last_seq: 9,
        stopped: 1,
      },
      {
        id: "a079426c9a96dd3cb",
        type: "",
        first_seq: 12,
        last_seq: 12,
        stopped: 0,
      },
    ]),
    prLinks: vi.fn().mockResolvedValue([]),
    repositories: vi.fn().mockResolvedValue([]),
    pullRequests: vi.fn().mockResolvedValue({
      pullRequests: [],
      complete: false,
      warnings: ["repository_not_connected"],
    }),
  };
  return { deps, handler: createRunWorkGetHandler(deps) };
}
describe("get_run_work", () => {
  it("denies viewers before reading checkout or provider evidence", async () => {
    role.current = "Viewer";
    const { handler, deps } = setup();
    await expect(handler({ runId: RUN_ID }, ctx())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(deps.contexts).not.toHaveBeenCalled();
    expect(deps.repositories).not.toHaveBeenCalled();
    expect(deps.pullRequests).not.toHaveBeenCalled();
  });
  it("resolves workspace access before reading any checkout or provider evidence", async () => {
    const { handler, deps } = setup();
    await expect(
      handler({ runId: RUN_ID }, ctx(OTHER_WORKSPACE)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(deps.contexts).not.toHaveBeenCalled();
    expect(deps.repositories).not.toHaveBeenCalled();
    expect(deps.pullRequests).not.toHaveBeenCalled();
  });
  it("keeps recorded locations when provider evidence is unavailable", async () => {
    const { handler } = setup();
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result).toMatchObject({
      runId: RUN_ID,
      complete: false,
      checkouts: [{ path: "/repo", branch: "main" }],
      warnings: ["repository_not_connected"],
    });
  });
  // ADR-171: one break early in a long run used to blank the checkout and
  // subagents for the rest of it. The facts stay, and the break is named.
  it("keeps the facts of a session whose chain broke and warns chain_break", async () => {
    const { handler } = setup({ chainVerified: false });
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result).toMatchObject({
      complete: false,
      checkouts: [{ path: "/repo", branch: "main" }],
      warnings: ["repository_not_connected", "chain_break"],
    });
    expect(result.subagents).toHaveLength(2);
  });
  it("adds no chain_break warning while the chain holds", async () => {
    const { handler } = setup({ chainVerified: true });
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.warnings).not.toContain("chain_break");
  });
  it("lists the subagents the session started from their hook frames", async () => {
    const { handler } = setup();
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.subagents).toEqual([
      {
        id: "a0182b6cd3a21d284",
        type: "Explore",
        firstSeq: "3",
        lastSeq: "9",
        stopped: true,
      },
      {
        id: "a079426c9a96dd3cb",
        type: null,
        firstSeq: "12",
        lastSeq: "12",
        stopped: false,
      },
    ]);
  });
  it("passes each harness PR link to the PR read as a recorded receipt", async () => {
    const { handler, deps } = setup();
    vi.mocked(deps.repositories).mockResolvedValue([
      {
        connectionId: "conn_1",
        providerRepositoryId: "R_1",
        host: "github.com",
        owner: "acme",
        name: "app",
        url: "https://github.com/acme/app",
        connected: true,
      },
    ]);
    vi.mocked(deps.prLinks).mockResolvedValue([
      {
        url: "https://github.com/acme/app/pull/41",
        number: "41",
        repository: "acme/app",
        first_seq: 20,
        first_ts: "2026-09-23 10:00:00.000",
      },
      {
        url: "https://github.com/Acme/App/pull/42",
        number: "",
        repository: "",
        first_seq: 30,
        first_ts: "2026-09-23 10:05:00.000",
      },
      {
        url: "https://github.com/other/repo/pull/7",
        number: "7",
        repository: "other/repo",
        first_seq: 40,
        first_ts: "2026-09-23 10:06:00.000",
      },
    ]);
    const result = await handler({ runId: RUN_ID }, ctx());
    const call = vi.mocked(deps.pullRequests).mock.calls[0]!;
    expect(call[4]).toEqual([
      { repositoryId: "R_1", number: 41, headSha: null },
      { repositoryId: "R_1", number: 42, headSha: null },
    ]);
    expect(result.warnings).toContain("recorded_repository_not_connected");
  });
  // #3791: the daemon seals a session's first hook before its first Git read,
  // so that frame names the path alone. As a checkout of its own it matched
  // no repository or branch, and the work read incomplete for good.
  it("folds the path-only first frame into the Git context at its path, and the work reads complete", async () => {
    const { handler, deps } = setup({ chainVerified: true });
    const pathOnly: WorkContextRow = {
      path: "/work/app",
      branch: "",
      head: "",
      remote: "",
      repository: "",
      first_seq: 0,
      last_seq: 0,
    };
    const located: WorkContextRow = {
      path: "/work/app",
      branch: "fix/run",
      head: "b".repeat(40),
      remote: workDigest("github.com/acme/app"),
      repository: "https://github.com/acme/app",
      first_seq: 1,
      last_seq: 9,
    };
    const diff = (context: WorkContextRow, seq: number): WorkDiffRow => ({
      ...context,
      seq,
      observed_at: "2026-09-25 10:00:00.000",
      base: "c".repeat(40),
      content_digest: "sha256:diff",
      bytes_ref: "blob",
      complete: "true",
      limitations: "",
      omitted: "",
      redactions: "[]",
      redaction_count: 0,
    });
    vi.mocked(deps.contexts).mockResolvedValue([pathOnly, located]);
    vi.mocked(deps.diffs).mockResolvedValue([
      diff(located, 9),
      diff(pathOnly, 0),
    ]);
    vi.mocked(deps.repositories).mockResolvedValue([
      {
        connectionId: "conn_1",
        providerRepositoryId: "R_1",
        host: "github.com",
        owner: "acme",
        name: "app",
        url: "https://github.com/acme/app",
        connected: true,
      },
    ]);
    // The real PR read over a GitHub that holds no PR for the branch, so
    // every warning comes from the checkouts the handler passes it.
    const github: WorkPrDeps = {
      client: vi.fn().mockResolvedValue({
        getRepoInfo: vi.fn().mockResolvedValue({ defaultBranch: "main" }),
        listPullRequests: vi.fn().mockResolvedValue([]),
      }),
      now: () => "2026-09-25T10:00:00Z",
    };
    vi.mocked(deps.pullRequests).mockImplementation(
      (scope, checkouts, repositories, _deps, recorded) =>
        readWorkPullRequests(scope, checkouts, repositories, github, recorded),
    );
    const result = await handler({ runId: RUN_ID }, ctx());
    const merged = checkoutId(located);
    expect(result.checkouts).toMatchObject([
      {
        id: merged,
        path: "/work/app",
        branch: "fix/run",
        firstSeq: "0",
        lastSeq: "9",
        repository: { connected: true },
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.complete).toBe(true);
    // A diff sealed on the path-only frame names the checkout it folded into.
    expect(result.diffs.map((d) => d.checkoutId)).toEqual([merged, merged]);
  });
  it("keeps a path-only location with no Git context, and still says what it lacks (negative)", async () => {
    const { handler, deps } = setup({ chainVerified: true });
    vi.mocked(deps.contexts).mockResolvedValue([
      {
        path: "/tmp/scratch",
        branch: "",
        head: "",
        remote: "",
        repository: "",
        first_seq: 0,
        last_seq: 4,
      },
    ]);
    vi.mocked(deps.pullRequests).mockImplementation(
      (scope, checkouts, repositories, _deps, recorded) =>
        readWorkPullRequests(
          scope,
          checkouts,
          repositories,
          { client: vi.fn(), now: () => "2026-09-25T10:00:00Z" },
          recorded,
        ),
    );
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.checkouts).toMatchObject([{ path: "/tmp/scratch" }]);
    expect(result.warnings).toEqual(["repository_not_connected"]);
    expect(result.complete).toBe(false);
  });
  // #3791: the fold can leave fewer checkouts than the read returned. A read
  // that returned one row past its limit may have cut rows the fold never
  // saw, so the limit is judged on the rows read.
  it("warns checkout_limit when the read hit its limit, though the fold leaves no more checkouts than the limit (negative)", async () => {
    const { handler, deps } = setup({ chainVerified: true });
    const pathOnly: WorkContextRow = {
      path: "/work/app",
      branch: "",
      head: "",
      remote: "",
      repository: "",
      first_seq: 0,
      last_seq: 0,
    };
    const branches = Array.from(
      { length: WORK_CONTEXT_CAP },
      (_, n): WorkContextRow => ({
        path: "/work/app",
        branch: `fix/${String(n)}`,
        head: "b".repeat(40),
        remote: workDigest("github.com/acme/app"),
        repository: "https://github.com/acme/app",
        first_seq: n + 1,
        last_seq: n + 1,
      }),
    );
    vi.mocked(deps.contexts).mockResolvedValue([pathOnly, ...branches]);
    const result = await handler({ runId: RUN_ID }, ctx());
    // The path-only row folded into the first branch read after it.
    expect(result.checkouts).toHaveLength(WORK_CONTEXT_CAP);
    expect(result.checkouts[0]).toMatchObject({
      branch: "fix/0",
      firstSeq: "0",
    });
    expect(result.warnings).toContain("checkout_limit");
    expect(result.complete).toBe(false);
  });
  it("reads a PR link from the frame first and its URL second", () => {
    expect(
      prLinkOf({
        url: "https://github.com/acme/app/pull/41",
        number: "",
        repository: "",
      }),
    ).toEqual({
      owner: "acme",
      name: "app",
      number: 41,
      url: "https://github.com/acme/app/pull/41",
    });
    expect(
      prLinkOf({
        url: "https://github.com/acme/app/pull/41",
        number: "41",
        repository: "fork/app",
      }),
    ).toMatchObject({ owner: "fork", name: "app", number: 41 });
    expect(
      prLinkOf({
        url: "http://github.com/acme/app/pull/41",
        number: "41",
        repository: "",
      }),
    ).toBeNull();
    expect(
      prLinkOf({
        url: "https://github.com/acme/app",
        number: "",
        repository: "",
      }),
    ).toBeNull();
  });
});
