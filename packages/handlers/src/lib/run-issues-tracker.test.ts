import { describe, expect, it, vi } from "vitest";
import type { ConnectedRunRepository } from "./run-work";
import {
  createIssueStateCache,
  ISSUE_STATE_CACHE_MAX,
  type IssueTrackerDeps,
  readClosingIssues,
  readIssueStates,
} from "./run-issues-tracker";

const scope = {
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
};
const acme: ConnectedRunRepository = {
  connectionId: "conn_1",
  providerRepositoryId: "R_1",
  host: "github.com",
  owner: "acme",
  name: "app",
  url: "https://github.com/acme/app",
  connected: true,
};
const view = (repo: ConnectedRunRepository) => ({
  host: repo.host,
  owner: repo.owner,
  name: repo.name,
  url: repo.url,
  connected: repo.connected,
});
const T0 = Date.parse("2026-09-26T10:00:00.000Z");

function issue(number: number, state: "open" | "closed" = "open") {
  return {
    number,
    title: `Issue ${String(number)}`,
    state,
    stateReason: null,
    url: `https://github.com/acme/app/issues/${String(number)}`,
    isPullRequest: false,
  };
}

function tracker(clock = { now: T0 }) {
  const getIssues = vi.fn(
    async ({ numbers }: { numbers: readonly number[] }) => ({
      issues: numbers.filter((n) => n !== 404).map((n) => issue(n)),
      missing: numbers.filter((n) => n === 404),
    }),
  );
  const listClosingIssues = vi.fn();
  const client = vi.fn(async () => ({ getIssues, listClosingIssues }));
  const deps: IssueTrackerDeps = {
    client,
    now: () => clock.now,
    cache: createIssueStateCache(),
  };
  return { deps, getIssues, listClosingIssues, client, clock };
}

const ask = (key: string, number: number, repository = view(acme)) => ({
  key,
  repository,
  number,
});

describe("readIssueStates (#3970)", () => {
  it("reads each repository's issues in one call, through its connection, with when GitHub answered", async () => {
    const t = tracker();
    const { states, warnings } = await readIssueStates(
      scope,
      [ask("a", 482), ask("b", 404)],
      [acme],
      t.deps,
    );
    expect(t.client).toHaveBeenCalledWith(scope, acme);
    expect(t.getIssues).toHaveBeenCalledOnce();
    expect(t.getIssues).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      numbers: [482, 404],
    });
    expect(states.get("a")).toEqual({
      title: "Issue 482",
      status: "open",
      statusRead: "read",
      readAt: "2026-09-26T10:00:00.000Z",
      url: "https://github.com/acme/app/issues/482",
      isPullRequest: false,
    });
    expect(states.get("b")).toMatchObject({
      status: null,
      statusRead: "not_found",
    });
    expect(warnings).toEqual([]);
  });

  it("answers from the cache inside 60 seconds, with the time GitHub answered", async () => {
    const t = tracker();
    await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    t.clock.now = T0 + 59_000;
    const again = await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    expect(t.getIssues).toHaveBeenCalledOnce();
    expect(again.states.get("a")?.readAt).toBe("2026-09-26T10:00:00.000Z");
  });

  it("reads GitHub again once the minute has passed", async () => {
    const t = tracker();
    await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    t.clock.now = T0 + 60_000;
    const again = await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    expect(t.getIssues).toHaveBeenCalledTimes(2);
    expect(again.states.get("a")?.readAt).toBe("2026-09-26T10:01:00.000Z");
  });

  it("never answers one workspace from another's cached read (negative)", async () => {
    const t = tracker();
    await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    await readIssueStates(
      { ...scope, workspaceId: "7b000000-0000-4000-8000-000000000002" },
      [ask("a", 482)],
      [acme],
      t.deps,
    );
    expect(t.getIssues).toHaveBeenCalledTimes(2);
  });

  it("holds at most the cache's bound, dropping the oldest state first", async () => {
    // The process cache lives as long as the server does, so its bound is
    // what keeps a long-lived process from growing with every issue read.
    const t = tracker();
    for (let i = 0; i < ISSUE_STATE_CACHE_MAX; i += 1)
      t.deps.cache.set(`old-${String(i)}`, { at: T0, found: null });
    await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    expect(t.deps.cache.size).toBe(ISSUE_STATE_CACHE_MAX);
    expect(t.deps.cache.has("old-0")).toBe(false);
    expect(t.deps.cache.has("old-1")).toBe(true);
    // The state just read is the one kept: a second load answers from it.
    await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    expect(t.getIssues).toHaveBeenCalledOnce();
  });

  it("says why a state was not read: no connection, not GitHub (negative)", async () => {
    const t = tracker();
    const { states } = await readIssueStates(
      scope,
      [
        ask("unconnected", 7, { ...view(acme), name: "lib", url: "https://github.com/acme/lib" }),
        ask("gitlab", 7, {
          host: "gitlab.com",
          owner: "acme",
          name: "app",
          url: "https://gitlab.com/acme/app",
          connected: false,
        }),
      ],
      [acme],
      t.deps,
    );
    expect(states.get("unconnected")?.statusRead).toBe("no_connection");
    expect(states.get("gitlab")?.statusRead).toBe("not_github");
    expect(t.getIssues).not.toHaveBeenCalled();
  });

  it("reads a failed call as read_failed, never as a state, and caches nothing (negative)", async () => {
    const t = tracker();
    t.getIssues.mockRejectedValueOnce(new Error("GitHub API error 502"));
    const { states } = await readIssueStates(
      scope,
      [ask("a", 482)],
      [acme],
      t.deps,
    );
    expect(states.get("a")).toMatchObject({
      status: null,
      statusRead: "read_failed",
      readAt: null,
    });
    await readIssueStates(scope, [ask("a", 482)], [acme], t.deps);
    expect(t.getIssues).toHaveBeenCalledTimes(2);
  });

  it("reads at most 50 issues a load, and says the rest were not read (negative)", async () => {
    const t = tracker();
    const requests = Array.from({ length: 51 }, (_, i) =>
      ask(`k${String(i)}`, i + 1),
    );
    const { states, warnings } = await readIssueStates(
      scope,
      requests,
      [acme],
      t.deps,
    );
    expect(t.getIssues.mock.calls[0]?.[0].numbers).toHaveLength(50);
    expect(states.get("k50")?.statusRead).toBe("read_limit");
    expect(states.get("k49")?.statusRead).toBe("read");
    expect(warnings).toEqual(["tracker_read_limit"]);
  });

  it("reports a number GitHub resolves to a pull request as one", async () => {
    const t = tracker();
    t.getIssues.mockResolvedValueOnce({
      issues: [{ ...issue(511), isPullRequest: true }],
      missing: [],
    });
    const { states } = await readIssueStates(
      scope,
      [ask("pr", 511)],
      [acme],
      t.deps,
    );
    expect(states.get("pr")?.isPullRequest).toBe(true);
  });
});

describe("readClosingIssues", () => {
  const pull = { repository: acme, number: 511, url: `${acme.url}/pull/511`, seq: "36" };

  it("reads GitHub's closing references for each pull request, and nothing else", async () => {
    const t = tracker();
    t.listClosingIssues.mockResolvedValue({
      issues: [
        {
          owner: "acme",
          repo: "app",
          number: 490,
          title: "Checkout fails",
          url: "https://github.com/acme/app/issues/490",
          state: "open",
        },
      ],
      complete: true,
    });
    const result = await readClosingIssues(scope, [pull], t.deps);
    expect(t.listClosingIssues).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      number: 511,
    });
    expect(result.closing[0]?.issues.map((i) => i.number)).toEqual([490]);
    expect(result.warnings).toEqual([]);
  });

  it("names an unread or cut-short list, never reading it as closing nothing (negative)", async () => {
    const t = tracker();
    t.listClosingIssues
      .mockRejectedValueOnce(new Error("graphql refused"))
      .mockResolvedValueOnce({ issues: [], complete: false });
    const result = await readClosingIssues(
      scope,
      [pull, { ...pull, number: 512 }],
      t.deps,
    );
    expect(result.warnings.sort()).toEqual([
      "closing_issue_limit",
      "closing_issues_read_failed",
    ]);
  });
});
