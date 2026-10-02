// The GitLab webhook receiver (#3762): authentication, duplicate and
// out-of-order deliveries, a project move, and a revoked token. The deps are
// in-memory: a connection, the open proposals, and a GitLab whose API answers
// the merge request's current state regardless of what the payload says.
import { describe, expect, it, vi } from "vitest";
import { GitLabApiError, type GitLabClient } from "@oxagen/gitlab";
import {
  CLOSED_ON_GITLAB,
  handleGitLabWebhook,
  type GitLabWebhookDeps,
  type WebhookConnection,
} from "./gitlab.webhook";
import { logger } from "./logger";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = "whsec-0123456789abcdef";
const TOKEN = "glpat-test-token-never-printed";

const CONNECTION: WebhookConnection = {
  id: "0192d4a8-7c1e-7a00-8000-00000000c011",
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  projectId: "4242",
  projectPath: "acme/platform/rules",
  token: TOKEN,
  webhookSecret: SECRET,
};

function mrEvent(over: {
  state?: string;
  iid?: number;
  projectId?: number;
  path?: string;
}) {
  return {
    object_kind: "merge_request",
    project: {
      id: over.projectId ?? 4242,
      path_with_namespace: over.path ?? "acme/platform/rules",
    },
    object_attributes: {
      iid: over.iid ?? 7,
      state: over.state ?? "opened",
      action: "update",
      source_branch: "context/use-pnpm",
      target_branch: "main",
      updated_at: "2026-09-23T10:00:00Z",
      last_commit: { id: "abc123" },
      merge_commit_sha: null,
    },
  };
}

/** A world the deps read and write, so a test asserts what a delivery did. */
function world(opts: {
  mrState?: "opened" | "closed" | "merged" | "locked";
  apiPath?: string;
  apiStatus?: number;
  connection?: WebhookConnection | null;
}) {
  const state = {
    proposals: new Map([[7, { id: "p-7", publicId: "prp_7", open: true }]]),
    rejected: [] as { id: string; reason: string }[],
    pathUpdates: [] as string[],
    credentialRejected: [] as string[],
    mrReads: 0,
  };
  const fail = () => {
    if (opts.apiStatus)
      throw new GitLabApiError(opts.apiStatus, "401 Unauthorized");
  };
  const client = {
    getProject: vi.fn(async () => {
      fail();
      return {
        id: "4242",
        pathWithNamespace: opts.apiPath ?? "acme/platform/rules",
        namespaceFullPath: "acme/platform",
        path: "rules",
        defaultBranch: "main",
        webUrl: "https://gitlab.com/acme/platform/rules",
        archived: false,
      };
    }),
    getMergeRequest: vi.fn(async ({ iid }: { iid: number }) => {
      fail();
      state.mrReads += 1;
      return { iid, state: opts.mrState ?? "opened" };
    }),
  } as unknown as GitLabClient;
  const deps: GitLabWebhookDeps = {
    findConnection: async (publicId) =>
      publicId === "con_gl1" ? (opts.connection ?? CONNECTION) : null,
    updateConnectionPath: async (_id, path) => {
      state.pathUpdates.push(path);
    },
    markCredentialRejected: async (id) => {
      state.credentialRejected.push(id);
    },
    findOpenProposal: async (_scope, iid) => {
      const p = state.proposals.get(iid);
      return p?.open ? { id: p.id, publicId: p.publicId } : null;
    },
    rejectProposal: async (id, reason) => {
      const p = [...state.proposals.values()].find((x) => x.id === id);
      if (!p?.open) return false;
      p.open = false;
      state.rejected.push({ id, reason });
      return true;
    },
    client: vi.fn(() => client),
    now: () => new Date("2026-09-23T10:05:00Z"),
    runInScope: (_scope, fn) => fn(),
  };
  return { deps, state, client };
}

const deliver = (
  deps: GitLabWebhookDeps,
  body: unknown,
  tokenHeader: string | null = SECRET,
  connectionPublicId = "con_gl1",
) => handleGitLabWebhook(deps, { connectionPublicId, tokenHeader, body });

describe("GitLab webhook: authentication", () => {
  it("answers one 401 for a missing token, a wrong token and an unknown connection", async () => {
    const { deps, state } = world({ mrState: "closed" });
    const body = mrEvent({ state: "closed" });
    const answers = await Promise.all([
      deliver(deps, body, null),
      deliver(deps, body, "whsec-wrong-wrong-wrong"),
      deliver(deps, body, SECRET, "con_unknown"),
    ]);
    for (const a of answers)
      expect(a).toEqual({ status: 401, outcome: "unauthenticated" });
    expect(state.rejected).toEqual([]);
    expect(deps.client).not.toHaveBeenCalled();
  });

  it("proceeds with the stored secret", async () => {
    const { deps } = world({});
    await expect(deliver(deps, mrEvent({}))).resolves.toEqual({
      status: 202,
      outcome: "no_change",
    });
  });

  it("ignores an unparseable body and another project's event", async () => {
    const { deps, state } = world({ mrState: "closed" });
    await expect(deliver(deps, { nope: true })).resolves.toMatchObject({
      outcome: "ignored_unparseable",
    });
    await expect(
      deliver(deps, mrEvent({ state: "closed", projectId: 9999 })),
    ).resolves.toMatchObject({ outcome: "ignored_other_project" });
    expect(state.rejected).toEqual([]);
  });
});

describe("GitLab webhook: merge request state comes from the API", () => {
  it("rejects the proposal once when the same close is delivered twice", async () => {
    const { deps, state } = world({ mrState: "closed" });
    const body = mrEvent({ state: "closed" });
    await expect(deliver(deps, body)).resolves.toEqual({
      status: 200,
      outcome: "proposal_rejected",
    });
    await expect(deliver(deps, body)).resolves.toEqual({
      status: 202,
      outcome: "no_proposal",
    });
    expect(state.rejected).toEqual([{ id: "p-7", reason: CLOSED_ON_GITLAB }]);
  });

  it("rejects on a stale 'opened' delivery for a merge request GitLab reports closed", async () => {
    const { deps, state } = world({ mrState: "closed" });
    await deliver(deps, mrEvent({ state: "opened" }));
    expect(state.rejected).toHaveLength(1);
  });

  it("does not reject on a stale 'closed' delivery for a merge request since reopened", async () => {
    const { deps, state } = world({ mrState: "opened" });
    await expect(deliver(deps, mrEvent({ state: "closed" }))).resolves.toEqual({
      status: 202,
      outcome: "no_change",
    });
    expect(state.rejected).toEqual([]);
    expect(state.mrReads).toBe(1);
  });

  it("leaves a merged merge request for merge_context_pr to publish", async () => {
    const { deps, state } = world({ mrState: "merged" });
    await expect(deliver(deps, mrEvent({ state: "merged" }))).resolves.toEqual({
      status: 202,
      outcome: "merged_awaiting_publication",
    });
    expect(state.rejected).toEqual([]);
  });

  it("does nothing for a merge request no open proposal holds", async () => {
    const { deps, state } = world({ mrState: "closed" });
    await expect(
      deliver(deps, mrEvent({ state: "closed", iid: 99 })),
    ).resolves.toMatchObject({ outcome: "no_proposal" });
    expect(state.mrReads).toBe(0);
  });

  it("reports a proposal that moved between the read and the write", async () => {
    const { deps } = world({ mrState: "closed" });
    deps.rejectProposal = async () => false;
    await expect(deliver(deps, mrEvent({ state: "closed" }))).resolves.toEqual({
      status: 202,
      outcome: "proposal_moved",
    });
  });
});

describe("GitLab webhook: project moves", () => {
  it("moves the path label when the API confirms the move", async () => {
    const { deps, state } = world({ apiPath: "acme/governance/rules" });
    await deliver(deps, mrEvent({ path: "acme/governance/rules" }));
    expect(state.pathUpdates).toEqual(["acme/governance/rules"]);
  });

  it("keeps the label when the payload claims a move the API does not report", async () => {
    const { deps, state } = world({});
    await deliver(deps, mrEvent({ path: "evil/elsewhere" }));
    expect(state.pathUpdates).toEqual([]);
  });

  it("follows a move on a non-merge-request event too", async () => {
    const { deps, state } = world({ apiPath: "acme/moved" });
    await expect(
      deliver(deps, {
        object_kind: "push",
        project: { id: 4242, path_with_namespace: "acme/moved" },
      }),
    ).resolves.toMatchObject({ outcome: "ignored_event" });
    expect(state.pathUpdates).toEqual(["acme/moved"]);
  });
});

describe("GitLab webhook: the repository sync (ADR-184)", () => {
  const SCOPE = {
    orgId: CONNECTION.orgId,
    workspaceId: CONNECTION.workspaceId,
  };
  const PUSH = {
    object_kind: "push",
    project: { id: 4242, path_with_namespace: "acme/platform/rules" },
  };

  it("asks for a sync on a push, in the connection's workspace", async () => {
    const { deps, state } = world({});
    const requestSync = vi.fn(async () => {});
    deps.requestSync = requestSync;
    await expect(deliver(deps, PUSH)).resolves.toEqual({
      status: 202,
      outcome: "sync_requested",
    });
    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(requestSync).toHaveBeenCalledWith(SCOPE, "push");
    // A push touches no proposal: the sync reads the branch and decides.
    expect(state.rejected).toEqual([]);
    expect(state.mrReads).toBe(0);
  });

  // Only the default branch can move steering. A feature-branch push would
  // put the page into "pending" for nothing.
  it("asks only for a push to the project's default branch", async () => {
    const { deps } = world({});
    const requestSync = vi.fn(async () => {});
    deps.requestSync = requestSync;
    const project = { ...PUSH.project, default_branch: "main" };
    await expect(
      deliver(deps, { ...PUSH, ref: "refs/heads/feature/x", project }),
    ).resolves.toMatchObject({ outcome: "ignored_event" });
    await expect(
      deliver(deps, { ...PUSH, ref: "refs/heads/main", project }),
    ).resolves.toMatchObject({ outcome: "sync_requested" });
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it("ignores a push when no sync can be requested", async () => {
    const { deps } = world({});
    await expect(deliver(deps, PUSH)).resolves.toEqual({
      status: 202,
      outcome: "ignored_event",
    });
  });

  it("does not ask for a sync on a push that fails authentication or names another project", async () => {
    // The scope comes from the connection, so an unauthenticated delivery or
    // a hook copied onto another project must not get to spend a sync on it.
    const { deps } = world({});
    const requestSync = vi.fn(async () => {});
    deps.requestSync = requestSync;
    await deliver(deps, PUSH, "whsec-wrong-wrong-wrong");
    await deliver(deps, { ...PUSH, project: { id: 9999 } });
    expect(requestSync).not.toHaveBeenCalled();
  });

  it("asks for a sync on a merge even when no open proposal holds the merge request", async () => {
    // Most merges onto the production branch are not Context PRs. The sync
    // still has to read them, because a person can edit .oxagen/rules/ in any
    // merge request.
    const { deps, state } = world({ mrState: "merged" });
    const requestSync = vi.fn(async () => {});
    deps.requestSync = requestSync;
    await expect(
      deliver(deps, mrEvent({ state: "merged", iid: 99 })),
    ).resolves.toEqual({ status: 202, outcome: "no_proposal" });
    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(requestSync).toHaveBeenCalledWith(SCOPE, "merge_request");
    expect(state.mrReads).toBe(0);
  });

  it("asks for a sync on a merge that an open proposal holds, and leaves the proposal for it", async () => {
    const { deps, state } = world({ mrState: "merged" });
    const requestSync = vi.fn(async () => {});
    deps.requestSync = requestSync;
    await expect(deliver(deps, mrEvent({ state: "merged" }))).resolves.toEqual({
      status: 202,
      outcome: "merged_awaiting_publication",
    });
    expect(requestSync).toHaveBeenCalledWith(SCOPE, "merge_request");
    expect(state.rejected).toEqual([]);
  });

  it("does not ask for a sync on a merge request that did not merge", async () => {
    // A close, an open or an update changes nothing on the production branch.
    const { deps } = world({ mrState: "closed" });
    const requestSync = vi.fn(async () => {});
    deps.requestSync = requestSync;
    await deliver(deps, mrEvent({ state: "closed" }));
    await deliver(deps, mrEvent({ state: "opened", iid: 99 }));
    expect(requestSync).not.toHaveBeenCalled();
  });
});

describe("GitLab webhook: revoked credentials", () => {
  it("marks the connection errored and touches no proposal", async () => {
    const { deps, state } = world({ mrState: "closed", apiStatus: 401 });
    const result = await deliver(deps, mrEvent({ state: "closed" }));
    expect(result).toEqual({ status: 202, outcome: "credential_rejected" });
    expect(state.credentialRejected).toEqual([CONNECTION.id]);
    expect(state.rejected).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rethrows any other GitLab failure", async () => {
    const { deps } = world({ mrState: "closed", apiStatus: 500 });
    await expect(deliver(deps, mrEvent({ state: "closed" }))).rejects.toThrow(
      GitLabApiError,
    );
  });
});

describe("GitLab webhook: the steering repo health check (S2, #4560)", () => {
  const MAIN_PUSH = {
    object_kind: "push",
    ref: "refs/heads/main",
    checkout_sha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
    user_username: "dana-ops",
    project: {
      id: 4242,
      path_with_namespace: "acme/platform/rules",
      default_branch: "main",
    },
    commits: [
      {
        id: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
        timestamp: "2026-09-26T18:12:44+02:00",
      },
    ],
  };

  function withHealthCheck(opts: Parameters<typeof world>[0] = {}) {
    const w = world(opts);
    const requestHealthCheck = vi.fn(async () => {});
    w.deps.requestHealthCheck = requestHealthCheck;
    return { ...w, requestHealthCheck };
  }

  it("asks for a health read on a push to main, for the connection's project", async () => {
    const { deps, requestHealthCheck } = withHealthCheck();
    await deliver(deps, MAIN_PUSH);
    expect(requestHealthCheck).toHaveBeenCalledTimes(1);
    expect(requestHealthCheck).toHaveBeenCalledWith({
      provider: "gitlab",
      repository_ids: [4242],
      installation_id: null,
      trigger: {
        reason: "push",
        actor: "dana-ops",
        at: "2026-09-26T16:12:44.000Z",
        settings: [],
        pull_request: null,
      },
    });
  });

  it("carries the merge request and its new head on an update", async () => {
    const { deps, requestHealthCheck } = withHealthCheck();
    await deliver(deps, mrEvent({}));
    expect(requestHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        repository_ids: [4242],
        trigger: expect.objectContaining({
          reason: "merge_request.update",
          pull_request: { number: 7, head_sha: "abc123" },
        }),
      }),
    );
  });

  it("asks on a system hook body the event parser cannot read, and still answers unparseable", async () => {
    const { deps, requestHealthCheck } = withHealthCheck();
    const body = {
      event_name: "project_update",
      project_id: 4242,
      updated_at: "2026-09-26T19:44:02Z",
      path_with_namespace: "acme/platform/rules",
    };
    await expect(deliver(deps, body)).resolves.toEqual({
      status: 202,
      outcome: "ignored_unparseable",
    });
    expect(requestHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({
          reason: "project_update",
          settings: ["visibility", "default_branch", "merge_requests", "ci_cd"],
        }),
      }),
    );
  });

  it("asks for nothing on a delivery that fails authentication", async () => {
    const { deps, requestHealthCheck } = withHealthCheck();
    await expect(
      deliver(deps, MAIN_PUSH, "whsec-wrong-wrong-wrong"),
    ).resolves.toMatchObject({ status: 401 });
    await deliver(deps, MAIN_PUSH, SECRET, "con_unknown");
    expect(requestHealthCheck).not.toHaveBeenCalled();
  });

  it("asks for nothing when the delivery names another project", async () => {
    const { deps, requestHealthCheck } = withHealthCheck();
    await deliver(deps, { ...MAIN_PUSH, project: { id: 9999, default_branch: "main" } });
    await deliver(deps, mrEvent({ projectId: 9999 }));
    expect(requestHealthCheck).not.toHaveBeenCalled();
  });

  it("asks for nothing on a delivery that cannot change health", async () => {
    const { deps, requestHealthCheck } = withHealthCheck();
    await deliver(deps, { ...MAIN_PUSH, ref: "refs/heads/context/use-pnpm" });
    await deliver(deps, { object_kind: "note", project: { id: 4242 } });
    await deliver(deps, null);
    await deliver(deps, [MAIN_PUSH]);
    expect(requestHealthCheck).not.toHaveBeenCalled();
  });

  it("logs a failed request and answers the delivery as before", async () => {
    const { deps, state } = world({ mrState: "closed" });
    deps.requestHealthCheck = vi.fn(async () => {
      throw new Error("event bus down");
    });
    vi.mocked(logger.error).mockClear();
    await expect(deliver(deps, mrEvent({ state: "closed" }))).resolves.toEqual({
      status: 200,
      outcome: "proposal_rejected",
    });
    expect(state.rejected).toEqual([{ id: "p-7", reason: CLOSED_ON_GITLAB }]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION.id, reason: "merge_request.update" }),
      expect.stringContaining("could not request a steering repo health check"),
    );
  });

  it("works without the dependency", async () => {
    const { deps } = world({});
    expect(deps.requestHealthCheck).toBeUndefined();
    await expect(deliver(deps, MAIN_PUSH)).resolves.toEqual({
      status: 202,
      outcome: "ignored_event",
    });
  });
});

describe("GitLab webhook: the Oxagen check on a code repository (S2b, #5058)", () => {
  it("asks once per merge request delivery, with the scope, the connection, the event, and the body", async () => {
    const { deps } = world({});
    const requestCodeCheck = vi.fn(async () => undefined);
    deps.requestCodeCheck = requestCodeCheck;
    const body = mrEvent({});
    await deliver(deps, body);
    expect(requestCodeCheck).toHaveBeenCalledTimes(1);
    expect(requestCodeCheck).toHaveBeenCalledWith(
      { orgId: CONNECTION.orgId, workspaceId: CONNECTION.workspaceId },
      CONNECTION,
      expect.objectContaining({
        kind: "merge_request",
        iid: 7,
        lastCommitSha: "abc123",
        targetBranch: "main",
      }),
      body,
    );
  });

  it("asks nothing for a push", async () => {
    const { deps } = world({});
    const requestCodeCheck = vi.fn(async () => undefined);
    deps.requestCodeCheck = requestCodeCheck;
    await deliver(deps, {
      object_kind: "push",
      ref: "refs/heads/feature",
      project: { id: 4242, path_with_namespace: "acme/platform/rules", default_branch: "main" },
    });
    expect(requestCodeCheck).not.toHaveBeenCalled();
  });

  it("logs a failed request and answers the delivery as before (negative)", async () => {
    const { deps, state } = world({ mrState: "closed" });
    deps.requestCodeCheck = vi.fn(async () => {
      throw new Error("event bus down");
    });
    vi.mocked(logger.error).mockClear();
    await expect(deliver(deps, mrEvent({ state: "closed" }))).resolves.toEqual({
      status: 200,
      outcome: "proposal_rejected",
    });
    expect(state.rejected).toEqual([{ id: "p-7", reason: CLOSED_ON_GITLAB }]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION.id, iid: 7 }),
      expect.stringContaining("could not request the Oxagen check"),
    );
  });
});
