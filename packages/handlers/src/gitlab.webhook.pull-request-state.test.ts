// The GitLab webhook stores each merge request's state on the run rows that
// name it (#4129, ADR-192): for every merge request delivery, whether or not
// a steering proposal is behind it, under newer-wins, and never failing the
// delivery.
import { describe, expect, it, vi } from "vitest";
import type { GitLabClient } from "@oxagen/gitlab";
import {
  handleGitLabWebhook,
  type GitLabWebhookDeps,
  type WebhookConnection,
} from "./gitlab.webhook";
import type { ForgeKey, ForgeState } from "./lib/run-pull-request-state";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = "whsec-0123456789abcdef";

const CONNECTION: WebhookConnection = {
  id: "0192d4a8-7c1e-7a00-8000-00000000c011",
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  projectId: "4242",
  projectPath: "Acme/Platform/Rules",
  token: "glpat-test-token-never-printed",
  webhookSecret: SECRET,
};

function mrEvent(attrs: Record<string, unknown>, path = "acme/platform/rules") {
  return {
    object_kind: "merge_request",
    project: { id: 4242, path_with_namespace: path },
    object_attributes: {
      iid: 7,
      state: "opened",
      action: "update",
      source_branch: "feature",
      target_branch: "main",
      updated_at: "2026-09-25T10:00:00Z",
      merge_commit_sha: null,
      ...attrs,
    },
  };
}

type Written = { scope: unknown; key: ForgeKey; forge: ForgeState };

function deps(record?: (w: Written) => Promise<number>) {
  const written: Written[] = [];
  const client = {
    // The project moved, as far as the payload says; the API keeps the
    // connection's label, so nothing is relabelled.
    getProject: vi.fn(async () => ({
      pathWithNamespace: CONNECTION.projectPath,
    })),
    getMergeRequest: vi.fn(),
  } as unknown as GitLabClient;
  const d: GitLabWebhookDeps = {
    findConnection: async (publicId) =>
      publicId === "con_gl1" ? CONNECTION : null,
    updateConnectionPath: vi.fn(),
    markCredentialRejected: vi.fn(),
    // No proposal: the state is stored before the proposal lookup answers.
    findOpenProposal: async () => null,
    rejectProposal: vi.fn(),
    client: () => client,
    now: () => new Date("2026-09-25T10:05:00Z"),
    runInScope: (_scope, fn) => fn(),
    recordPullRequestState: async (scope, key, forge) => {
      const w = { scope, key, forge };
      written.push(w);
      return record ? record(w) : 1;
    },
  };
  return { deps: d, written, client };
}

const deliver = (d: GitLabWebhookDeps, body: unknown) =>
  handleGitLabWebhook(d, {
    connectionPublicId: "con_gl1",
    tokenHeader: SECRET,
    body,
  });

describe("GitLab webhook: merge request state", () => {
  it("stores a draft merge request's state with GitLab's updated_at, reading no API", async () => {
    const { deps: d, written, client } = deps();
    const out = await deliver(d, mrEvent({ draft: true }));
    expect(out).toEqual({ status: 202, outcome: "no_proposal" });
    expect(written).toEqual([
      {
        scope: {
          orgId: CONNECTION.orgId,
          workspaceId: CONNECTION.workspaceId,
        },
        key: {
          provider: "gitlab",
          repository: "acme/platform/rules",
          number: 7,
        },
        forge: {
          state: "open",
          draft: true,
          sourceUpdatedAt: new Date("2026-09-25T10:00:00Z"),
        },
      },
    ]);
    expect(client.getMergeRequest).not.toHaveBeenCalled();
  });

  it("stores merged, and closed without a draft flag", async () => {
    const { deps: d, written } = deps();
    await deliver(d, mrEvent({ state: "merged", draft: true }));
    await deliver(d, mrEvent({ state: "closed" }));
    expect(written.map((w) => w.forge.state)).toEqual(["merged", "closed"]);
    expect(written.every((w) => !w.forge.draft)).toBe(true);
  });

  it("stores under both paths when the project moved", async () => {
    const { deps: d, written } = deps();
    await deliver(d, mrEvent({}, "acme/platform/rules-renamed"));
    expect(written.map((w) => w.key.repository).sort()).toEqual([
      "acme/platform/rules",
      "acme/platform/rules-renamed",
    ]);
  });

  it("answers the delivery as before when storing fails (negative)", async () => {
    const { deps: d } = deps(() => Promise.reject(new Error("pg down")));
    expect(await deliver(d, mrEvent({ state: "merged" }))).toEqual({
      status: 202,
      outcome: "no_proposal",
    });
  });

  it("stores nothing for a state GitLab has not documented (negative)", async () => {
    const { deps: d, written } = deps();
    await deliver(d, mrEvent({ state: "archived" }));
    expect(written).toEqual([]);
  });

  it("stores nothing for a push or a note (negative)", async () => {
    const { deps: d, written } = deps();
    await deliver(d, { object_kind: "note", project: { id: 4242 } });
    expect(written).toEqual([]);
  });

  it("stores nothing for an unauthenticated delivery (negative)", async () => {
    const { deps: d, written } = deps();
    await handleGitLabWebhook(d, {
      connectionPublicId: "con_gl1",
      tokenHeader: "whsec-wrong-wrong-wrong",
      body: mrEvent({ state: "merged" }),
    });
    expect(written).toEqual([]);
  });

  it("stores nothing for another project's hook (negative)", async () => {
    const { deps: d, written } = deps();
    const body = mrEvent({ state: "merged" });
    body.project.id = 9999;
    await deliver(d, body);
    expect(written).toEqual([]);
  });
});
