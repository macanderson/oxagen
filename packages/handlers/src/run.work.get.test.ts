import { runWorkGet } from "@oxagen/oxagen/contracts/run.work.get";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRefFrameRow } from "./lib/run-command-refs";
import { prLinkOf } from "./lib/run-work";
import { readWorkReleases } from "./lib/run-work-releases";
import { createRunWorkGetHandler, type RunWorkDeps } from "./run.work.get";
import type { TachoSessionColumns } from "./run.list";
import {
  ctx,
  ledgerRun,
  memoryStores,
  summary,
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
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
// `summary()`'s run: the ledger store answers it for LEDGER_ID.
const LEDGER_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
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
    commandFrames: vi.fn().mockResolvedValue([]),
    // The real release read over a fake GitHub, so the handler's wiring and
    // the read's rules are tested together.
    releases: (scope, frames, checkouts, repositories) =>
      readWorkReleases(scope, frames, checkouts, repositories, {
        client: async () => ({ listReleases: github.listReleases }),
      }),
  };
  return { deps, handler: createRunWorkGetHandler(deps) };
}

const github = vi.hoisted(() => ({ listReleases: vi.fn() }));
beforeEach(() => {
  github.listReleases.mockReset();
  github.listReleases.mockResolvedValue([]);
});

const CONNECTED = {
  connectionId: "conn_1",
  providerRepositoryId: "R_1",
  host: "github.com",
  owner: "acme",
  name: "app",
  url: "https://github.com/acme/app",
  connected: true,
};

/** A command frame, as `readRunCommandRefFrames` returns it. */
function commandFrame(
  seq: number,
  command: string,
  path = "/repo",
): CommandRefFrameRow {
  return {
    seq,
    command,
    path,
    observed_at: "2026-09-26 10:00:05.000",
    issue_repository: "",
    issue_number: "",
    issue_url: "",
    issue_action: "",
    release_repository: "",
    release_tag: "",
  };
}

// #3890: the Changes panel's Release row draws a release only when one
// exists, with GitHub's state for it.
describe("get_run_work releases", () => {
  it("returns a release the session created, with the state GitHub reads for it now", async () => {
    const { handler, deps } = setup();
    vi.mocked(deps.repositories).mockResolvedValue([CONNECTED]);
    vi.mocked(deps.commandFrames).mockResolvedValue([
      commandFrame(31, "gh release create v4.11.0 --draft -R acme/app"),
      // The same release again adds no second row.
      commandFrame(33, "gh release create v4.11.0 --draft -R acme/app"),
    ]);
    github.listReleases.mockResolvedValue([
      {
        tagName: "v4.11.0",
        name: "4.11.0",
        htmlUrl: "https://github.com/acme/app/releases/tag/untagged-1",
        draft: true,
        prerelease: false,
        publishedAt: null,
      },
    ]);
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(runWorkGet.output.parse(result)).toEqual(result);
    expect(result.releases).toEqual([
      {
        repository: {
          host: "github.com",
          owner: "acme",
          name: "app",
          url: "https://github.com/acme/app",
          connected: true,
        },
        tag: "v4.11.0",
        name: "4.11.0",
        url: "https://github.com/acme/app/releases/tag/untagged-1",
        state: "draft",
        frameSeq: "31",
        observedAt: "2026-09-26T10:00:05.000Z",
      },
    ]);
    expect(github.listReleases).toHaveBeenCalledOnce();
    expect(github.listReleases).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
    });
  });

  it("reads a published and a prerelease state, and resolves a bare command from the checkout it ran in", async () => {
    const { handler, deps } = setup();
    vi.mocked(deps.repositories).mockResolvedValue([CONNECTED]);
    vi.mocked(deps.contexts).mockResolvedValue([
      {
        path: "/repo",
        branch: "release/4.11",
        head: "abc",
        remote: "",
        repository: "https://github.com/acme/app",
        first_seq: 0,
        last_seq: 40,
      },
    ]);
    vi.mocked(deps.commandFrames).mockResolvedValue([
      commandFrame(31, "gh release create v4.11.0"),
      commandFrame(32, "gh release create v4.12.0-rc.1 --prerelease"),
    ]);
    github.listReleases.mockResolvedValue([
      {
        tagName: "v4.12.0-rc.1",
        name: null,
        htmlUrl: "https://github.com/acme/app/releases/tag/v4.12.0-rc.1",
        draft: false,
        prerelease: true,
        publishedAt: "2026-09-26T10:01:00Z",
      },
      {
        tagName: "v4.11.0",
        name: "v4.11.0",
        htmlUrl: "https://github.com/acme/app/releases/tag/v4.11.0",
        draft: false,
        prerelease: false,
        publishedAt: "2026-09-26T10:00:30Z",
      },
    ]);
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.releases.map(({ tag, state }) => [tag, state])).toEqual([
      ["v4.11.0", "published"],
      ["v4.12.0-rc.1", "prerelease"],
    ]);
  });

  it("keeps a release in an unconnected repository with a null state and a warning (negative)", async () => {
    const { handler, deps } = setup();
    vi.mocked(deps.commandFrames).mockResolvedValue([
      commandFrame(31, "gh release create v1.0.0 -R other/lib"),
    ]);
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.releases).toEqual([
      expect.objectContaining({
        tag: "v1.0.0",
        state: null,
        url: null,
        repository: expect.objectContaining({
          owner: "other",
          name: "lib",
          connected: false,
        }),
      }),
    ]);
    expect(result.warnings).toContain("recorded_repository_not_connected");
    expect(result.complete).toBe(false);
    expect(github.listReleases).not.toHaveBeenCalled();
  });

  it("says GitHub has no such release, or could not be read, rather than guessing a state (negative)", async () => {
    const { handler, deps } = setup();
    vi.mocked(deps.repositories).mockResolvedValue([CONNECTED]);
    vi.mocked(deps.commandFrames).mockResolvedValue([
      commandFrame(31, "gh release create v9.9.9 -R acme/app"),
    ]);
    const missing = await handler({ runId: RUN_ID }, ctx());
    expect(missing.releases[0]?.state).toBeNull();
    expect(missing.warnings).toContain("release_not_found");
    github.listReleases.mockRejectedValue(new Error("GitHub API error 502"));
    const failed = await handler({ runId: RUN_ID }, ctx());
    expect(failed.releases[0]?.state).toBeNull();
    expect(failed.warnings).toContain("release_read_failed");
  });

  it("leaves out a release whose repository the record does not name, and says so (negative)", async () => {
    const { handler, deps } = setup();
    // The one checkout recorded no repository, and the command names none.
    vi.mocked(deps.commandFrames).mockResolvedValue([
      commandFrame(31, "gh release create v1.0.0"),
    ]);
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.releases).toEqual([]);
    expect(result.warnings).toContain("release_repository_unknown");
  });

  it("returns no release when the session created none", async () => {
    const { handler, deps } = setup();
    vi.mocked(deps.commandFrames).mockResolvedValue([
      commandFrame(31, "gh release view v4.11.0"),
      commandFrame(32, "gh issue view 482"),
    ]);
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.releases).toEqual([]);
    expect(result.warnings).toEqual(["repository_not_connected"]);
  });

  it("returns no release for a ledger run, which records no command", async () => {
    const stores = memoryStores(
      [ledgerRun({ publicId: LEDGER_ID, runId: LEDGER_UUID })],
      [],
    );
    const { deps } = setup();
    const handler = createRunWorkGetHandler({
      ...deps,
      queries: stores.queries,
      readRunRollups: stores.readRunRollups,
      readWitnessFor: stores.readWitnessFor,
      store: {
        getRunByPublicId: async (publicId) =>
          publicId === LEDGER_ID ? summary() : null,
        readAttemptEventsSince: async () => [],
      },
    });
    const result = await handler({ runId: LEDGER_ID }, ctx());
    expect(result.releases).toEqual([]);
    expect(deps.commandFrames).not.toHaveBeenCalled();
  });
});
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
