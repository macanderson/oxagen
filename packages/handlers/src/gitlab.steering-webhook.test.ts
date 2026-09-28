// The GitLab steering hook receiver (#4562): authentication against the
// project the scope's own state names, the events that ask for a health check
// or a sync, the deliveries it ignores, and a request that fails. The deps are
// in memory, and each payload has the shape GitLab documents for its event.
import { describe, expect, it, vi } from "vitest";
import {
  handleGitLabSteeringWebhook,
  type GitLabSteeringWebhookDeps,
  type SteeringHookProject,
} from "./gitlab.steering-webhook";
import { steeringHookToken } from "./lib/steering-hook";
import { logger } from "./logger";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = "a-steering-hook-secret-of-32-chars!";
const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WORKSPACE = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const PROJECT = 4242;

const WORKSPACE_PROJECT: SteeringHookProject = {
  scope: { orgId: ORG, workspaceId: WORKSPACE },
  projectId: PROJECT,
};
const ORG_PROJECT: SteeringHookProject = {
  scope: { orgId: ORG, workspaceId: null },
  projectId: PROJECT,
};

type Deps = GitLabSteeringWebhookDeps;

function world(
  project: SteeringHookProject | null = WORKSPACE_PROJECT,
  opts: { health?: boolean; sync?: boolean } = {},
) {
  const deps = {
    findSteeringProject: vi.fn<Deps["findSteeringProject"]>(
      async () => project,
    ),
    secret: vi.fn<Deps["secret"]>(() => SECRET),
    requestHealthCheck: vi.fn<NonNullable<Deps["requestHealthCheck"]>>(
      async () => {},
    ),
    requestSync: vi.fn<NonNullable<Deps["requestSync"]>>(async () => {}),
  };
  const injected: GitLabSteeringWebhookDeps = {
    findSteeringProject: deps.findSteeringProject,
    secret: deps.secret,
  };
  if (opts.health !== false)
    injected.requestHealthCheck = deps.requestHealthCheck;
  if (opts.sync !== false) injected.requestSync = deps.requestSync;
  return { deps, injected };
}

function tokenFor(
  kind: "workspace" | "organization",
  scopeId: string,
  projectId = PROJECT,
) {
  return steeringHookToken(SECRET, { kind, scopeId, projectId });
}

function workspaceRequest(body: unknown, tokenHeader?: string | null) {
  return {
    scopeKind: "workspace",
    scopeId: WORKSPACE,
    tokenHeader:
      tokenHeader === undefined ? tokenFor("workspace", WORKSPACE) : tokenHeader,
    body,
  };
}

/** A push event as a project hook sends it. */
function push(over: { ref?: string; projectId?: number | string } = {}) {
  return {
    object_kind: "push",
    event_name: "push",
    ref: over.ref ?? "refs/heads/main",
    before: "0000000000000000000000000000000000000000",
    after: "3c1f0d3e5b8f1a2c4d6e8f0a1b2c3d4e5f6a7b8c",
    project_id: over.projectId ?? PROJECT,
    project: {
      id: over.projectId ?? PROJECT,
      path_with_namespace: "acme/oxagen-core",
      default_branch: "main",
    },
    commits: [],
    total_commits_count: 1,
  };
}

/** A merge request event as a project hook sends it. */
function mergeRequest(state: "opened" | "merged" | "closed", projectId = PROJECT) {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    project: { id: projectId, path_with_namespace: "acme/oxagen-core" },
    object_attributes: {
      iid: 12,
      state,
      action: state === "merged" ? "merge" : "open",
      source_branch: "context/use-pnpm",
      target_branch: "main",
      target_project_id: projectId,
    },
  };
}

describe("handleGitLabSteeringWebhook authentication", () => {
  it("answers 401 for a scope kind it does not know, before any lookup", async () => {
    const { deps, injected } = world();
    const res = await handleGitLabSteeringWebhook(injected, {
      ...workspaceRequest(push()),
      scopeKind: "org",
    });
    expect(res).toEqual({ status: 401, outcome: "unauthenticated" });
    expect(deps.findSteeringProject).not.toHaveBeenCalled();
  });

  it("answers 401 for a scope id that is not a uuid, before any lookup", async () => {
    const { deps, injected } = world();
    const res = await handleGitLabSteeringWebhook(injected, {
      ...workspaceRequest(push()),
      scopeId: "1; drop table workspaces",
    });
    expect(res.status).toBe(401);
    expect(deps.findSteeringProject).not.toHaveBeenCalled();
  });

  it("answers 401 when the scope has no GitLab steering project", async () => {
    const { deps, injected } = world(null);
    const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(push()));
    expect(res).toEqual({ status: 401, outcome: "unauthenticated" });
    expect(deps.findSteeringProject).toHaveBeenCalledWith("workspace", WORKSPACE);
    expect(deps.requestHealthCheck).not.toHaveBeenCalled();
  });

  it("answers 401 for a missing or wrong token", async () => {
    const { deps, injected } = world();
    for (const header of [null, "", "not-the-token"]) {
      const res = await handleGitLabSteeringWebhook(
        injected,
        workspaceRequest(push(), header),
      );
      expect(res.status).toBe(401);
    }
    expect(deps.requestHealthCheck).not.toHaveBeenCalled();
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it("answers 401 for a token made for another project, scope or kind", async () => {
    const { injected } = world();
    const others = [
      tokenFor("workspace", WORKSPACE, PROJECT + 1),
      tokenFor("workspace", ORG),
      tokenFor("organization", WORKSPACE),
      steeringHookToken(`${SECRET}x`, {
        kind: "workspace",
        scopeId: WORKSPACE,
        projectId: PROJECT,
      }),
    ];
    for (const token of others) {
      const res = await handleGitLabSteeringWebhook(
        injected,
        workspaceRequest(push(), token),
      );
      expect(res.status).toBe(401);
    }
  });

  it("accepts the organization scope with its own token", async () => {
    const { deps, injected } = world(ORG_PROJECT);
    const res = await handleGitLabSteeringWebhook(injected, {
      scopeKind: "organization",
      scopeId: ORG,
      tokenHeader: tokenFor("organization", ORG),
      body: push(),
    });
    expect(res).toEqual({ status: 202, outcome: "health_requested" });
    expect(deps.findSteeringProject).toHaveBeenCalledWith("organization", ORG);
  });
});

describe("handleGitLabSteeringWebhook events", () => {
  it("asks for a health check and a sync on a push to the default branch", async () => {
    const { deps, injected } = world();
    const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(push()));
    expect(res).toEqual({ status: 202, outcome: "health_requested" });
    expect(deps.requestHealthCheck).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      "push",
    );
    expect(deps.requestSync).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      "push",
    );
  });

  it("ignores a push to another branch", async () => {
    const { deps, injected } = world();
    const res = await handleGitLabSteeringWebhook(
      injected,
      workspaceRequest(push({ ref: "refs/heads/context/use-pnpm" })),
    );
    expect(res).toEqual({ status: 202, outcome: "ignored_event" });
    expect(deps.requestHealthCheck).not.toHaveBeenCalled();
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it("asks the organization scope for a health check and no sync", async () => {
    const { deps, injected } = world(ORG_PROJECT);
    await handleGitLabSteeringWebhook(injected, {
      scopeKind: "organization",
      scopeId: ORG,
      tokenHeader: tokenFor("organization", ORG),
      body: push(),
    });
    expect(deps.requestHealthCheck).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: null },
      "push",
    );
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it("reports the sync when no health check is plugged in", async () => {
    const { deps, injected } = world(WORKSPACE_PROJECT, { health: false });
    const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(push()));
    expect(res).toEqual({ status: 202, outcome: "sync_requested" });
    expect(deps.requestSync).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing on a push when neither request is plugged in", async () => {
    const { injected } = world(WORKSPACE_PROJECT, { health: false, sync: false });
    const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(push()));
    expect(res).toEqual({ status: 202, outcome: "ignored_event" });
  });

  it("asks for a sync and no health check when a merge request merges", async () => {
    const { deps, injected } = world();
    const res = await handleGitLabSteeringWebhook(
      injected,
      workspaceRequest(mergeRequest("merged")),
    );
    expect(res).toEqual({ status: 202, outcome: "sync_requested" });
    expect(deps.requestSync).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      "merge_request",
    );
    expect(deps.requestHealthCheck).not.toHaveBeenCalled();
  });

  it("ignores a merge request that has not merged", async () => {
    const { deps, injected } = world();
    for (const state of ["opened", "closed"] as const) {
      const res = await handleGitLabSteeringWebhook(
        injected,
        workspaceRequest(mergeRequest(state)),
      );
      expect(res.outcome).toBe("ignored_event");
    }
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it("asks for a health check on a group hook's project event", async () => {
    const { deps, injected } = world();
    const res = await handleGitLabSteeringWebhook(
      injected,
      workspaceRequest({
        event_name: "project_rename",
        name: "oxagen-core",
        path_with_namespace: "acme/oxagen-core",
        project_id: PROJECT,
        old_path_with_namespace: "acme/oxagen",
      }),
    );
    expect(res).toEqual({ status: 202, outcome: "health_requested" });
    expect(deps.requestHealthCheck).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      "project",
    );
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it("asks for a health check on a group hook's member event", async () => {
    const { deps, injected } = world();
    const res = await handleGitLabSteeringWebhook(
      injected,
      workspaceRequest({
        event_name: "user_add_to_group",
        group_id: 78,
        group_name: "acme",
        group_access: "Owner",
        user_username: "mallory",
      }),
    );
    expect(res.outcome).toBe("health_requested");
    expect(deps.requestHealthCheck).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      "member",
    );
  });

  it("ignores an event it does not act on", async () => {
    const { deps, injected } = world();
    for (const body of [
      { object_kind: "note", project: { id: PROJECT } },
      { event_name: "repository_update", project_id: PROJECT },
      {},
    ]) {
      const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(body));
      expect(res).toEqual({ status: 202, outcome: "ignored_event" });
    }
    expect(deps.requestHealthCheck).not.toHaveBeenCalled();
    expect(deps.requestSync).not.toHaveBeenCalled();
  });
});

describe("handleGitLabSteeringWebhook deliveries it ignores", () => {
  it("ignores a body that is not a JSON object", async () => {
    const { deps, injected } = world();
    for (const body of [null, "push", [push()]]) {
      const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(body));
      expect(res).toEqual({ status: 202, outcome: "ignored_unparseable" });
    }
    expect(deps.requestHealthCheck).not.toHaveBeenCalled();
  });

  it("ignores a delivery that names another project", async () => {
    const { deps, injected } = world();
    const bodies = [
      push({ projectId: PROJECT + 1 }),
      mergeRequest("merged", PROJECT + 1),
      { event_name: "user_add_to_team", project_id: PROJECT + 1 },
    ];
    for (const body of bodies) {
      const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(body));
      expect(res).toEqual({ status: 202, outcome: "ignored_other_project" });
    }
    expect(deps.requestHealthCheck).not.toHaveBeenCalled();
    expect(deps.requestSync).not.toHaveBeenCalled();
  });

  it("reads a project id sent as a decimal string", async () => {
    const { deps, injected } = world();
    const mine = await handleGitLabSteeringWebhook(
      injected,
      workspaceRequest(push({ projectId: String(PROJECT) })),
    );
    expect(mine.outcome).toBe("health_requested");
    const other = await handleGitLabSteeringWebhook(
      injected,
      workspaceRequest(push({ projectId: String(PROJECT + 1) })),
    );
    expect(other.outcome).toBe("ignored_other_project");
    expect(deps.requestHealthCheck).toHaveBeenCalledTimes(1);
  });
});

describe("handleGitLabSteeringWebhook failed requests", () => {
  it("answers 202 and still asks for the sync when the health request throws", async () => {
    const { deps, injected } = world();
    deps.requestHealthCheck.mockRejectedValueOnce(new Error("inngest down"));
    const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(push()));
    expect(res).toEqual({ status: 202, outcome: "sync_requested" });
    expect(deps.requestSync).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, workspaceId: WORKSPACE, reason: "push" }),
      expect.stringContaining("health check"),
    );
  });

  it("answers 202 when the sync request throws", async () => {
    const { deps, injected } = world();
    deps.requestSync.mockRejectedValueOnce(new Error("inngest down"));
    const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(push()));
    expect(res).toEqual({ status: 202, outcome: "health_requested" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, reason: "push" }),
      expect.stringContaining("steering sync"),
    );
  });

  it("answers 202 with nothing requested when both requests throw", async () => {
    const { deps, injected } = world();
    deps.requestHealthCheck.mockRejectedValueOnce(new Error("down"));
    deps.requestSync.mockRejectedValueOnce(new Error("down"));
    const res = await handleGitLabSteeringWebhook(injected, workspaceRequest(push()));
    expect(res).toEqual({ status: 202, outcome: "ignored_event" });
  });
});
