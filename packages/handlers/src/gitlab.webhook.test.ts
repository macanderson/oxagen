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
