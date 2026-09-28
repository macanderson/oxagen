// The steering hook receiver's real lookup against a migrated database
// (#4562): it finds a GitLab steering project from the scope's own
// `steering_repo` setting, whatever the repo's status, and finds nothing for
// a GitHub repo, an archived workspace, or an unknown id. Runs wherever
// DATABASE_URL points at a migrated database, as CI's unit lanes do. A local
// run without one is skipped, not red. Every row it writes is removed in
// afterAll.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq, inArray } from "drizzle-orm";
import { gitlabSteeringWebhookDeps } from "./gitlab.steering-webhook";
import { requestSteeringSync } from "./context.steering.sync.request";

vi.mock("./context.steering.sync.request", () => ({
  requestSteeringSync: vi.fn(async () => undefined),
}));

const enabled = Boolean(process.env.DATABASE_URL);

function steeringRepo(provider: "github" | "gitlab", id: number, status: string) {
  return {
    steering_repo: {
      status,
      provider,
      repository: {
        id,
        owner: "acme",
        name: "oxagen-core",
        full_name: "acme/oxagen-core",
        initial_branch: "main",
      },
    },
  };
}

describe.skipIf(!enabled)("gitlabSteeringWebhookDeps against Postgres", () => {
  const orgId = crypto.randomUUID();
  const gitlabWorkspace = crypto.randomUUID();
  const githubWorkspace = crypto.randomUUID();
  const archivedWorkspace = crypto.randomUUID();
  const plainWorkspace = crypto.randomUUID();
  const workspaceIds = [
    gitlabWorkspace,
    githubWorkspace,
    archivedWorkspace,
    plainWorkspace,
  ];
  const tag = orgId.slice(0, 8);
  const deps = gitlabSteeringWebhookDeps();

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `S8 steering hook ${tag}`,
        slug: `s8-hook-${tag}`,
        namespace: `h${tag.slice(0, 5)}`,
        planType: "enterprise",
        status: "active",
        settings: steeringRepo("gitlab", 9001, "ready"),
      });
      await tx.insert(schema.workspaces).values([
        {
          id: gitlabWorkspace,
          orgId,
          name: "Core",
          slug: "core",
          namespace: "core",
          settings: steeringRepo("gitlab", 4242, "provisioning"),
        },
        {
          id: githubWorkspace,
          orgId,
          name: "Docs",
          slug: "docs",
          namespace: "docs",
          settings: steeringRepo("github", 5151, "ready"),
        },
        {
          id: archivedWorkspace,
          orgId,
          name: "Old",
          slug: "old",
          namespace: "old",
          settings: steeringRepo("gitlab", 6161, "ready"),
          archivedAt: new Date(),
          archivedByUserId: crypto.randomUUID(),
        },
        {
          id: plainWorkspace,
          orgId,
          name: "Plain",
          slug: "plain",
          namespace: "plain",
        },
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.workspaceSlugHistory)
        .where(inArray(schema.workspaceSlugHistory.workspaceId, workspaceIds));
      await tx
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.id, workspaceIds));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
    });
    await closeDatabase();
  });

  it("finds a workspace's GitLab steering project before the repo is ready", async () => {
    await expect(
      deps.findSteeringProject("workspace", gitlabWorkspace),
    ).resolves.toEqual({
      scope: { orgId, workspaceId: gitlabWorkspace },
      projectId: 4242,
    });
  });

  it("finds the organization's GitLab steering project", async () => {
    await expect(
      deps.findSteeringProject("organization", orgId),
    ).resolves.toEqual({
      scope: { orgId, workspaceId: null },
      projectId: 9001,
    });
  });

  it("finds nothing for a GitHub repo, an archived workspace or no repo", async () => {
    for (const id of [githubWorkspace, archivedWorkspace, plainWorkspace])
      await expect(deps.findSteeringProject("workspace", id)).resolves.toBeNull();
  });

  it("finds nothing for an id of the other kind or an unknown id", async () => {
    await expect(deps.findSteeringProject("workspace", orgId)).resolves.toBeNull();
    await expect(
      deps.findSteeringProject("organization", gitlabWorkspace),
    ).resolves.toBeNull();
    await expect(
      deps.findSteeringProject("workspace", crypto.randomUUID()),
    ).resolves.toBeNull();
  });

  it("reads the secret from BETTER_AUTH_SECRET", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "a-steering-hook-secret-of-32-chars!");
    try {
      expect(deps.secret()).toBe("a-steering-hook-secret-of-32-chars!");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("asks the steering sync for the one workspace", async () => {
    await deps.requestSync?.(
      { orgId, workspaceId: gitlabWorkspace },
      "merge_request",
    );
    expect(requestSteeringSync).toHaveBeenCalledWith(
      [{ orgId, workspaceId: gitlabWorkspace }],
      "merge_request",
    );
  });

  it("leaves the health check out until #4560 plugs it in", () => {
    expect(deps.requestHealthCheck).toBeUndefined();
  });
});
