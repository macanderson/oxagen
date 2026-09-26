import { runIssuesGet } from "@oxagen/oxagen/contracts/run.issues.get";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRefFrameRow } from "./lib/run-command-refs";
import type { IssueState } from "./lib/run-issues-tracker";
import type { ConnectedRunRepository } from "./lib/run-work";
import { createRunIssuesGetHandler, type RunIssuesDeps } from "./run.issues.get";
import type { TachoSessionColumns } from "./run.list";
import {
  ctx,
  event,
  ledgerRun,
  memoryStores,
  OTHER_WORKSPACE,
  roleTx,
  summary,
  tachoSession,
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

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
// `summary()`'s run: the ledger store answers it for LEDGER_ID.
const LEDGER_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";

const acme: ConnectedRunRepository = {
  connectionId: "conn_1",
  providerRepositoryId: "R_1",
  host: "github.com",
  owner: "acme",
  name: "app",
  url: "https://github.com/acme/app",
  connected: true,
};

function commandFrame(seq: number, command: string): CommandRefFrameRow {
  return {
    seq,
    command,
    path: "/work/app",
    observed_at: "2026-09-26 10:00:00.000",
    issue_repository: "",
    issue_number: "",
    issue_url: "",
    issue_action: "",
  };
}

function closingIssue(number: number, state: "open" | "closed" = "open") {
  return {
    owner: "acme",
    repo: "app",
    number,
    title: `Closing ${String(number)}`,
    url: `https://github.com/acme/app/issues/${String(number)}`,
    state,
  };
}

/** The tracker's answer: every issue asked for reads open, titled by number. */
function readAll(
  _scope: unknown,
  requests: readonly { key: string; number: number }[],
) {
  const states = new Map<string, IssueState>(
    requests.map((request): [string, IssueState] => [
      request.key,
      {
        title: `Issue ${String(request.number)}`,
        status: "open",
        statusRead: "read",
        readAt: "2026-09-26T10:00:00.000Z",
        url: null,
        isPullRequest: false,
      },
    ]),
  );
  return Promise.resolve({ states, warnings: [] as string[] });
}

function setup(
  over: {
    session?: Partial<TachoSessionColumns>;
    ledgerTask?: string | null;
  } = {},
) {
  const stores = memoryStores(
    [
      {
        ...ledgerRun({ publicId: LEDGER_ID, runId: LEDGER_UUID }),
        identity: {
          ...ledgerRun({ publicId: LEDGER_ID, runId: LEDGER_UUID }).identity,
          goal: over.ledgerTask === undefined ? "acme/app#482" : over.ledgerTask,
        },
      },
    ],
    [tachoSession({ publicId: TACHO_ID, session: over.session ?? {} })],
  );
  const deps = {
    queries: stores.queries,
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    store: {
      getRunByPublicId: async (publicId: string) =>
        publicId === LEDGER_ID ? summary() : null,
      readAttemptEventsSince: vi.fn(async () => [
        event(4, {
          eventType: "provider_publish.pull_request_opened",
          payload: {
            provider_repository_id: "R_1",
            pull_request_number: 511,
            head_commit_sha: "abc",
          },
        }),
      ]),
    },
    tachoFrames: async () => [],
    contexts: vi.fn().mockResolvedValue([
      {
        path: "/work/app",
        branch: "fix/482",
        head: "abc",
        remote: "",
        repository: "https://github.com/acme/app",
        first_seq: 0,
        last_seq: 40,
      },
    ]),
    prLinks: vi.fn().mockResolvedValue([
      {
        url: "https://github.com/acme/app/pull/511",
        number: "511",
        repository: "acme/app",
        first_seq: 30,
        first_ts: "2026-09-26 10:00:30.000",
      },
    ]),
    commandFrames: vi.fn().mockResolvedValue([]),
    repositories: vi.fn().mockResolvedValue([acme]),
    closingIssues: vi.fn(
      async (
        _scope: unknown,
        pulls: readonly { number: number; url: string; seq: string | null }[],
      ) => ({
        closing: pulls.map((pull) => ({
          pull: { ...pull, repository: acme },
          issues: [closingIssue(490)],
        })),
        warnings: [] as string[],
      }),
    ),
    tracker: vi.fn(readAll),
  } satisfies RunIssuesDeps;
  return { deps, handler: createRunIssuesGetHandler(deps) };
}

describe("get_run_issues (#3970)", () => {
  it("refuses a viewer before reading any frame or asking GitHub (negative)", async () => {
    role.current = "Viewer";
    const { handler, deps } = setup();
    await expect(handler({ runId: TACHO_ID }, ctx())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(deps.commandFrames).not.toHaveBeenCalled();
    expect(deps.closingIssues).not.toHaveBeenCalled();
    expect(deps.tracker).not.toHaveBeenCalled();
  });

  it("answers not_found for a run outside the caller's workspace, and reads nothing (negative)", async () => {
    const { handler, deps } = setup();
    await expect(
      handler({ runId: TACHO_ID }, ctx(OTHER_WORKSPACE)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(deps.repositories).not.toHaveBeenCalled();
    expect(deps.commandFrames).not.toHaveBeenCalled();
  });

  it("lists the issues a wrapped run's pull requests close and its frames name, each observed, in frame order", async () => {
    const { handler, deps } = setup();
    deps.commandFrames.mockResolvedValue([
      commandFrame(12, "gh issue view 482"),
      commandFrame(15, "gh issue comment 482 -b 'on it'"),
      // A closing issue a frame also names stays `resolves`.
      commandFrame(33, "gh issue view 490 -R acme/app"),
    ]);
    const result = await handler({ runId: TACHO_ID }, ctx());
    expect(runIssuesGet.output.parse(result)).toEqual(result);
    expect(result.complete).toBe(true);
    expect(result.warnings).toEqual([]);
    const [referenced, resolves] = result.issues;
    // The bare #482 resolves to the checkout the frames ran in.
    expect(referenced).toEqual({
      ref: "acme/app#482",
      repository: {
        host: "github.com",
        owner: "acme",
        name: "app",
        url: "https://github.com/acme/app",
        connected: true,
      },
      number: 482,
      title: "Issue 482",
      status: "open",
      statusRead: "read",
      readAt: "2026-09-26T10:00:00.000Z",
      relation: "referenced",
      resolvedBy: [],
      actions: ["viewed", "commented"],
      edge: "observed",
      frameSeqs: ["12", "15"],
      url: "https://github.com/acme/app/issues/482",
    });
    expect(resolves).toMatchObject({
      ref: "acme/app#490",
      title: "Closing 490",
      status: "open",
      statusRead: "read",
      relation: "resolves",
      resolvedBy: [{ number: 511, url: "https://github.com/acme/app/pull/511" }],
      actions: ["viewed"],
      edge: "observed",
      frameSeqs: ["30", "33"],
      url: "https://github.com/acme/app/issues/490",
    });
    expect(result.issues).toHaveLength(2);
    // GitHub gave the closing issue's state with its closing list, so only
    // the referenced issue is read from the tracker.
    expect(deps.tracker.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ key: "acme/app#482", number: 482 }),
    ]);
  });

  it("reads a closing list only for a pull request the run recorded opening, never one matched by branch (negative)", async () => {
    const { handler, deps } = setup();
    deps.prLinks.mockResolvedValue([]);
    const result = await handler({ runId: TACHO_ID }, ctx());
    // The checkout is on `fix/482`, and still no issue is inferred from it.
    expect(deps.closingIssues).toHaveBeenCalledWith(expect.anything(), []);
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("lists a ledger run's task as stated and what its pull requests close as resolves, and reads no frames", async () => {
    const { handler, deps } = setup();
    const result = await handler({ runId: LEDGER_ID }, ctx());
    expect(runIssuesGet.output.parse(result)).toEqual(result);
    expect(result.issues.map((row) => [row.ref, row.relation, row.edge])).toEqual(
      [
        ["acme/app#482", "task", "stated"],
        ["acme/app#490", "resolves", "observed"],
      ],
    );
    expect(result.issues[1]).toMatchObject({
      resolvedBy: [{ number: 511, url: "https://github.com/acme/app/pull/511" }],
      frameSeqs: ["4"],
    });
    expect(result.issues[0]).toMatchObject({
      statusRead: "read",
      url: "https://github.com/acme/app/issues/482",
    });
    expect(deps.commandFrames).not.toHaveBeenCalled();
    expect(deps.contexts).not.toHaveBeenCalled();
  });

  it("keeps the task stated when a pull request also closes it, and carries that frame", async () => {
    const { handler, deps } = setup();
    deps.closingIssues.mockImplementation(async (_scope, pulls) => ({
      closing: pulls.map((pull) => ({
        pull: { ...pull, repository: acme },
        issues: [closingIssue(482, "closed")],
      })),
      warnings: [],
    }));
    const result = await handler({ runId: LEDGER_ID }, ctx());
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      ref: "acme/app#482",
      relation: "task",
      edge: "stated",
      // The task's resolvedBy stays empty: the contract fills it for resolves.
      resolvedBy: [],
      frameSeqs: ["4"],
      status: "closed",
    });
  });

  it("names a task in another tracker without reading it (negative)", async () => {
    const { handler, deps } = setup({ ledgerTask: "ENG-4121" });
    deps.closingIssues.mockResolvedValue({ closing: [], warnings: [] });
    const result = await handler({ runId: LEDGER_ID }, ctx());
    expect(result.issues).toEqual([
      expect.objectContaining({
        ref: "ENG-4121",
        repository: null,
        number: null,
        status: null,
        statusRead: "not_github",
        url: null,
        relation: "task",
      }),
    ]);
    expect(deps.tracker.mock.calls[0]?.[1]).toEqual([]);
  });

  it("says a bare number whose repository the record cannot name is unknown, not a guess (negative)", async () => {
    const { handler, deps } = setup();
    deps.contexts.mockResolvedValue([]);
    deps.prLinks.mockResolvedValue([]);
    deps.commandFrames.mockResolvedValue([commandFrame(8, "gh issue view 3")]);
    const result = await handler({ runId: TACHO_ID }, ctx());
    expect(result.issues).toEqual([
      expect.objectContaining({
        ref: "#3",
        repository: null,
        statusRead: "repository_unknown",
        url: null,
        edge: "observed",
      }),
    ]);
  });

  it("marks the list incomplete when a closing list was not read (negative)", async () => {
    const { handler, deps } = setup();
    deps.closingIssues.mockResolvedValue({
      closing: [],
      warnings: ["closing_issues_read_failed"],
    });
    const result = await handler({ runId: TACHO_ID }, ctx());
    expect(result.complete).toBe(false);
    expect(result.warnings).toContain("closing_issues_read_failed");
  });

  it("keeps the list whole when only a state was not read, and says why for that row", async () => {
    const { handler, deps } = setup();
    deps.commandFrames.mockResolvedValue([commandFrame(12, "gh issue view 482")]);
    deps.tracker.mockResolvedValue({
      states: new Map<string, IssueState>([
        [
          "acme/app#482",
          {
            title: null,
            status: null,
            statusRead: "read_failed",
            readAt: null,
            url: null,
            isPullRequest: false,
          },
        ],
      ]),
      warnings: [],
    });
    const result = await handler({ runId: TACHO_ID }, ctx());
    expect(result.complete).toBe(true);
    expect(result.issues[0]).toMatchObject({
      ref: "acme/app#482",
      status: null,
      statusRead: "read_failed",
      // The page is still named from the record.
      url: "https://github.com/acme/app/issues/482",
    });
  });

  it("drops a number GitHub says is a pull request, and says so (negative)", async () => {
    const { handler, deps } = setup();
    deps.commandFrames.mockResolvedValue([commandFrame(12, "gh issue view 511")]);
    deps.tracker.mockImplementation(async (_scope, requests) => ({
      states: new Map<string, IssueState>(
        requests.map((request): [string, IssueState] => [
          request.key,
          {
            title: "Release notes",
            status: "closed",
            statusRead: "read",
            readAt: "2026-09-26T10:00:00.000Z",
            url: "https://github.com/acme/app/pull/511",
            isPullRequest: true,
          },
        ]),
      ),
      warnings: [],
    }));
    const result = await handler({ runId: TACHO_ID }, ctx());
    expect(result.issues.map((row) => row.ref)).toEqual(["acme/app#490"]);
    expect(result.warnings).toContain("pull_request_ref_skipped");
  });

  it("says a broken chain may hide issues, and still lists every frame's (ADR-171)", async () => {
    const { handler, deps } = setup({ session: { chainVerified: false } });
    deps.commandFrames.mockResolvedValue([commandFrame(12, "gh issue view 482")]);
    const result = await handler({ runId: TACHO_ID }, ctx());
    expect(result.issues).toHaveLength(2);
    expect(result.warnings).toContain("chain_break");
    expect(result.complete).toBe(false);
  });
});
