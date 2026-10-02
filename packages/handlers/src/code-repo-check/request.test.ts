// Which workspaces a pull request delivery asks to check (S2b, #5058), read
// from recorded webhook payloads in ./fixtures/. The binding heads are an
// in-memory table, so a test states which workspaces link the repository and
// which one holds it as its steering repo.
import { readFileSync } from "node:fs";
import { parseGitLabWebhookEvent, type GitLabMergeRequestEvent } from "@oxagen/gitlab";
import { describe, expect, it, vi } from "vitest";

vi.mock("../event-client", () => ({ eventClient: { send: vi.fn() } }));

import { eventClient } from "../event-client";
import {
  checkEvent,
  githubCodeCheckRequests,
  githubPullRequestClose,
  githubPullRequestHead,
  gitlabCodeCheckRequest,
  gitlabMergeRequestClose,
  gitlabMergeRequestHead,
  linkedScopes,
  requestCodeRepoChecks,
  type HeadRow,
  type LinkedScopeDeps,
} from "./request";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const OTHER_ORG = "0192d4a8-7c1e-7a00-8000-00000000ac4f";
const PLATFORM = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const BILLING = "0192d4a8-7c1e-7a00-8000-0000000c0e02";
const DEDICATED = "0192d4a8-7c1e-7a00-8000-0000000c0e03";
const CONNECTION_ID = "0192d4a8-7c1e-7a00-8000-00000000c011";

/** Binding heads keyed by `<provider>:<repository id>`, on the shared plane and on dedicated ones. */
function heads(shared: Record<string, HeadRow[]>, dedicated: Record<string, HeadRow[]> = {}) {
  const deps: LinkedScopeDeps = {
    sharedHeads: vi.fn<LinkedScopeDeps["sharedHeads"]>(async (provider, id) => [...(shared[`${provider}:${id}`] ?? [])]),
    dedicatedScopes: vi.fn<LinkedScopeDeps["dedicatedScopes"]>(async () =>
      Object.values(dedicated)
        .flat()
        .map((row) => ({ orgId: row.orgId, workspaceId: row.workspaceId })),
    ),
    headsOnPlane: vi.fn<LinkedScopeDeps["headsOnPlane"]>(async (scope, provider, id) =>
      [...(shared[`${provider}:${id}`] ?? []), ...(dedicated[`${provider}:${id}`] ?? [])].filter(
        (row) => row.workspaceId === scope.workspaceId,
      ),
    ),
  };
  return deps;
}

const linked = (orgId: string, workspaceId: string): HeadRow => ({ orgId, workspaceId, role: "linked" });
const steering = (orgId: string, workspaceId: string): HeadRow => ({ orgId, workspaceId, role: "steering" });

describe("githubPullRequestHead", () => {
  it("reads the repository, the pull request, and the two commits from an opened pull request", () => {
    expect(githubPullRequestHead(fixture("github-pull-request-opened"))).toEqual({
      repositoryId: "771020341",
      fullName: "a-intel/platform",
      number: 318,
      url: "https://github.com/a-intel/platform/pull/318",
      headSha: "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718",
      base: "1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5",
    });
  });

  it("reads the new head from a synchronize delivery", () => {
    expect(githubPullRequestHead(fixture("github-pull-request-synchronize"))?.headSha).toBe(
      "c47a0e9d1f2b3c4d5e6f708192a3b4c5d6e7f809",
    );
  });

  it("reads nothing from a closed pull request or a labeled one (negative)", () => {
    expect(githubPullRequestHead(fixture("github-pull-request-closed"))).toBeNull();
    expect(
      githubPullRequestHead({ ...fixture("github-pull-request-opened"), action: "labeled" }),
    ).toBeNull();
  });
});

describe("githubCodeCheckRequests", () => {
  it("asks once per workspace that links the repository, with the installation", async () => {
    const deps = heads({
      "github:771020341": [linked(ORG, PLATFORM), linked(OTHER_ORG, BILLING)],
    });
    const events = await githubCodeCheckRequests(
      { body: fixture("github-pull-request-opened"), installationId: "61200044" },
      deps,
    );
    expect(events).toEqual([
      {
        id: `code-repo-check:${PLATFORM}:github:771020341:318:9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718:1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5`,
        name: "code-repo/check.requested",
        data: {
          orgId: ORG,
          workspaceId: PLATFORM,
          provider: "github",
          repositoryId: "771020341",
          fullName: "a-intel/platform",
          number: 318,
          url: "https://github.com/a-intel/platform/pull/318",
          headSha: "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718",
          base: "1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5",
          installationId: 61200044,
          connectionId: null,
          key: `${PLATFORM}:github:771020341:318`,
          closed: null,
          mergeCommitSha: null,
        },
      },
      expect.objectContaining({
        data: expect.objectContaining({ orgId: OTHER_ORG, workspaceId: BILLING }),
      }),
    ]);
  });

  it("asks a workspace on a dedicated plane in its own scope", async () => {
    const deps = heads({}, { "github:771020341": [linked(ORG, DEDICATED)] });
    const events = await githubCodeCheckRequests(
      { body: fixture("github-pull-request-opened"), installationId: "61200044" },
      deps,
    );
    expect(events.map((e) => e.data.workspaceId)).toEqual([DEDICATED]);
    expect(deps.headsOnPlane).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: DEDICATED },
      "github",
      "771020341",
    );
  });

  it("gives a new head a new event id, so a redelivery of the old one stays deduplicated", async () => {
    const deps = heads({ "github:771020341": [linked(ORG, PLATFORM)] });
    const [opened] = await githubCodeCheckRequests(
      { body: fixture("github-pull-request-opened"), installationId: "61200044" },
      deps,
    );
    const [pushed] = await githubCodeCheckRequests(
      { body: fixture("github-pull-request-synchronize"), installationId: "61200044" },
      deps,
    );
    expect(opened?.id).not.toBe(pushed?.id);
    expect(opened?.data.key).toBe(pushed?.data.key);
  });

  it("ignores a repository no workspace links (negative)", async () => {
    const events = await githubCodeCheckRequests(
      { body: fixture("github-pull-request-opened"), installationId: "61200044" },
      heads({}),
    );
    expect(events).toEqual([]);
  });

  it("leaves a steering repo's own pull request to the steering check (negative)", async () => {
    const deps = heads({ "github:904211873": [steering(ORG, PLATFORM)] });
    const events = await githubCodeCheckRequests(
      { body: fixture("github-pull-request-steering-repo"), installationId: "61200044" },
      deps,
    );
    expect(events).toEqual([]);
  });

  it("asks nothing for a delivery with no installation (negative)", async () => {
    const deps = heads({ "github:771020341": [linked(ORG, PLATFORM)] });
    await expect(
      githubCodeCheckRequests(
        { body: fixture("github-pull-request-opened"), installationId: null },
        deps,
      ),
    ).resolves.toEqual([]);
    expect(deps.sharedHeads).not.toHaveBeenCalled();
  });

  it("asks each linking workspace to settle a merged pull request's findings, with the merge commit (ADR-263)", async () => {
    const deps = heads({ "github:771020341": [linked(ORG, PLATFORM)] });
    const events = await githubCodeCheckRequests(
      { body: fixture("github-pull-request-closed"), installationId: "61200044" },
      deps,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(
      `code-repo-check:${PLATFORM}:github:771020341:318:merged:c47a0e9d1f2b3c4d5e6f708192a3b4c5d6e7f809`,
    );
    expect(events[0]?.data).toMatchObject({
      closed: "merged",
      mergeCommitSha: "5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3a2918",
      headSha: "c47a0e9d1f2b3c4d5e6f708192a3b4c5d6e7f809",
      key: `${PLATFORM}:github:771020341:318`,
    });
  });
});

describe("githubPullRequestClose", () => {
  it("reads a pull request closed without merging, with no merge commit", () => {
    const body = fixture("github-pull-request-closed");
    const pr = body.pull_request as Record<string, unknown>;
    const closed = githubPullRequestClose({
      ...body,
      pull_request: { ...pr, merged: false, merge_commit_sha: "5c4b3a29" },
    });
    expect(closed?.close).toEqual({ closed: "unmerged", mergeCommitSha: null });
    expect(closed?.head.number).toBe(318);
  });

  it("reads nothing from an opened pull request (negative)", () => {
    expect(githubPullRequestClose(fixture("github-pull-request-opened"))).toBeNull();
  });
});

describe("linkedScopes", () => {
  it("answers no workspace when any workspace holds the repository as its steering repo", async () => {
    const deps = heads({ "github:5": [linked(ORG, BILLING), steering(ORG, PLATFORM)] });
    await expect(linkedScopes("github", "5", deps)).resolves.toEqual([]);
  });
});

describe("the GitLab merge request request", () => {
  const body = fixture("gitlab-merge-request-opened");
  const event = parseGitLabWebhookEvent(body) as GitLabMergeRequestEvent;
  const scope = { orgId: ORG, workspaceId: PLATFORM };

  it("reads the project, the merge request, the head commit, and the target branch", () => {
    expect(gitlabMergeRequestHead(event, body)).toEqual({
      repositoryId: "4242",
      fullName: "acme/platform/api",
      number: 7,
      url: "https://gitlab.com/acme/platform/api/-/merge_requests/7",
      headSha: "5f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e",
      base: "main",
    });
  });

  it("asks for the connection's workspace when it links the project", async () => {
    const deps = heads({ "gitlab:4242": [linked(ORG, PLATFORM)] });
    const request = await gitlabCodeCheckRequest(
      { scope, connectionId: CONNECTION_ID, event, body },
      deps,
    );
    expect(request?.data).toMatchObject({
      provider: "gitlab",
      repositoryId: "4242",
      installationId: null,
      connectionId: CONNECTION_ID,
      base: "main",
      key: `${PLATFORM}:gitlab:4242:7`,
    });
    expect(deps.headsOnPlane).toHaveBeenCalledWith(scope, "gitlab", "4242");
  });

  it("ignores a project the workspace does not link, and its steering repo (negative)", async () => {
    await expect(
      gitlabCodeCheckRequest({ scope, connectionId: CONNECTION_ID, event, body }, heads({})),
    ).resolves.toBeNull();
    await expect(
      gitlabCodeCheckRequest(
        { scope, connectionId: CONNECTION_ID, event, body },
        heads({ "gitlab:4242": [steering(ORG, PLATFORM)] }),
      ),
    ).resolves.toBeNull();
  });

  it("asks nothing for a merged merge request or one with no head commit (negative)", () => {
    expect(gitlabMergeRequestHead({ ...event, state: "merged" }, body)).toBeNull();
    expect(gitlabMergeRequestHead({ ...event, lastCommitSha: null }, body)).toBeNull();
    expect(gitlabMergeRequestHead({ ...event, action: "approved" }, body)).toBeNull();
  });

  it("asks the workspace to settle a merge request that merged or closed (ADR-263)", async () => {
    const merged = { ...event, state: "merged", action: "merge", mergeCommitSha: "7a6b5c4d" };
    expect(gitlabMergeRequestClose(merged, body)?.close).toEqual({
      closed: "merged",
      mergeCommitSha: "7a6b5c4d",
    });
    const request = await gitlabCodeCheckRequest(
      { scope, connectionId: CONNECTION_ID, event: merged, body },
      heads({ "gitlab:4242": [linked(ORG, PLATFORM)] }),
    );
    expect(request?.data).toMatchObject({ closed: "merged", mergeCommitSha: "7a6b5c4d" });
    expect(
      gitlabMergeRequestClose({ ...event, state: "closed", action: "close" }, body)?.close,
    ).toEqual({ closed: "unmerged", mergeCommitSha: null });
  });

  it("settles nothing on a later update to a merged merge request (negative)", () => {
    expect(
      gitlabMergeRequestClose({ ...event, state: "merged", action: "update" }, body),
    ).toBeNull();
  });
});

describe("requestCodeRepoChecks", () => {
  it("sends every request in one batch, each with its id", async () => {
    const head = githubPullRequestHead(fixture("github-pull-request-opened"));
    if (head === null) throw new Error("the fixture names no pull request");
    const event = checkEvent({ orgId: ORG, workspaceId: PLATFORM }, "github", head, {
      installationId: 61200044,
    });
    await expect(requestCodeRepoChecks([event])).resolves.toBe(1);
    expect(eventClient.send).toHaveBeenCalledWith([
      { id: event.id, name: "code-repo/check.requested", data: event.data },
    ]);
  });

  it("sends nothing for no requests", async () => {
    vi.mocked(eventClient.send).mockClear();
    await expect(requestCodeRepoChecks([])).resolves.toBe(0);
    expect(eventClient.send).not.toHaveBeenCalled();
  });
});
