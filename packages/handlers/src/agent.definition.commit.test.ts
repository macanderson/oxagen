// commit_agent_definition handler tests (#2956, ADR-057 decision 1).
//
// The file readers are pure. The flow — the file checks, the repository
// binding, the branch guard, the GitHub writes and the cached version row —
// is proven against a real Postgres with the GitHub client replaced by a
// recorder, so the test asserts what was pushed where: a branch created from
// the default branch, one file put on that branch, one pull request against
// the default branch, and never a write to the default branch. The recorder
// keeps GitHub's one rule that matters here: a head with an open pull request
// cannot get a second one (POST /pulls answers 422). Runs where
// DATABASE_URL is set (CI's `test` job); locally:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/agent.definition.commit.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import { AGENT_DEFINITION_SCHEMA } from "@oxagen/oxagen/contracts/agent.definition.commit";

const gh = vi.hoisted(() => ({
  defaultBranch: "main",
  branches: [] as string[],
  /** Heads with an open pull request, as `owner:branch`. */
  openHeads: [] as string[],
  calls: [] as { op: string; args: Record<string, unknown> }[],
  client: {
    getRepoInfo: vi.fn(async () => ({ defaultBranch: gh.defaultBranch })),
    listBranches: vi.fn(async () => gh.branches.map((name) => ({ name }))),
    createBranch: vi.fn(
      async (args: { branch: string; fromBranch: string }) => {
        gh.calls.push({ op: "createBranch", args });
        gh.branches.push(args.branch);
        return { ref: `refs/heads/${args.branch}`, sha: "base000" };
      },
    ),
    putFile: vi.fn(async (args: Record<string, unknown>) => {
      gh.calls.push({ op: "putFile", args });
      return { commitSha: "c0ffee01", contentSha: "b10b" };
    }),
    listPullRequests: vi.fn(async (args: { head: string; state: string }) => {
      gh.calls.push({ op: "listPullRequests", args });
      return gh.openHeads.includes(args.head) && args.state === "open"
        ? [{ number: 42, htmlUrl: "https://github.com/acme/core/pull/42" }]
        : [];
    }),
    openPullRequest: vi.fn(
      async (
        args: { owner: string; head: string } & Record<string, unknown>,
      ) => {
        gh.calls.push({ op: "openPullRequest", args });
        const head = `${args.owner}:${args.head}`;
        if (gh.openHeads.includes(head)) {
          throw new Error(
            `GitHub API 422: A pull request already exists for ${head}.`,
          );
        }
        gh.openHeads.push(head);
        return { number: 42, htmlUrl: "https://github.com/acme/core/pull/42" };
      },
    ),
  },
}));

vi.mock("@oxagen/github", () => ({
  createGitHubClient: vi.fn(() => gh.client),
}));
vi.mock("@oxagen/github/workspace-token", () => ({
  resolveGitHubToken: vi.fn(async () => "ghs_test"),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  agentDefinitionCommitHandler,
  capabilityToolsOf,
  definitionPathFor,
  readTopLevelString,
  readTopLevelStringArray,
} from "./agent.definition.commit";

const SOURCE = (slug: string, tools: string[] = []) =>
  [
    `schema = "${AGENT_DEFINITION_SCHEMA}"`,
    `slug = "${slug}"`,
    `name = "Release bot"`,
    `tools = [${tools.map((t) => `"${t}"`).join(", ")}]`,
    "",
    "[harness.stella]",
    'tools = ["not-the-belt"]',
    "",
  ].join("\n");

describe("the definition file readers", () => {
  it("read a top-level string before the first table, with escapes and a trailing comment", () => {
    const src =
      'schema = "agent-definition/v0.1" # the schema\nslug = "a-\\"quoted\\"-slug"\n[x]\nslug = "inner"\n';
    expect(readTopLevelString(src, "schema")).toBe("agent-definition/v0.1");
    expect(readTopLevelString(src, "slug")).toBe('a-\\"quoted\\"-slug');
    expect(readTopLevelString(src, "name")).toBeNull();
    expect(readTopLevelString('[t]\nslug = "inner"', "slug")).toBeNull();
  });

  it("read a top-level string array across lines and ignore one inside a table", () => {
    expect(
      readTopLevelStringArray(SOURCE("x", ["list_runs", "get_run"]), "tools"),
    ).toEqual(["list_runs", "get_run"]);
    expect(
      readTopLevelStringArray('tools = [\n  "a",\n  "b",\n]\n', "tools"),
    ).toEqual(["a", "b"]);
    expect(
      readTopLevelStringArray('[harness.stella]\ntools = ["a"]', "tools"),
    ).toEqual([]);
    expect(readTopLevelStringArray('tools = ["unterminated"', "tools")).toEqual(
      [],
    );
  });

  it("name the file by the slug and keep only registered capabilities as ceiling-checked tools", () => {
    expect(definitionPathFor("release-bot")).toBe(
      ".oxagen/agents/release-bot.toml",
    );
    expect(
      capabilityToolsOf([
        "list_runs",
        "github__create_release",
        "mcp:*",
        "no_such_capability",
      ]),
    ).toEqual(["list_runs"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "commit_agent_definition against Postgres",
  async () => {
    const { withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq } = await import("drizzle-orm");
    const support = await import(
      "@oxagen/agent/handlers/_agent-identity.test-support"
    );
    const { agentGetHandler } = await import(
      "@oxagen/agent/handlers/agent.get"
    );

    type Tenant =
      import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    let tenant: Tenant;
    let unbound: Tenant;
    let viewerTenant: Tenant;
    let agent: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededAgent;
    let ownerRoleId = "";
    let bindingPublicId = "";
    const orgIds: string[] = [];
    const userIds: string[] = [];

    const commit = (
      t: Tenant,
      input: Parameters<typeof agentDefinitionCommitHandler>[0],
      planTier?: "free" | "enterprise",
    ) =>
      runInTenantScope({ orgId: t.orgId, workspaceId: t.workspaceId }, () =>
        agentDefinitionCommitHandler(input, {
          ...support.ctxFor(t, t.userId),
          ...(planTier ? { planTier } : {}),
        }),
      );

    async function seedBinding(t: Tenant, name: string, defaultRef: string) {
      return withSystemDb(async (tx) => {
        const connectionId = crypto.randomUUID();
        const [binding] = await tx
          .insert(schema.repositoryBindings)
          .values({
            orgId: t.orgId,
            workspaceId: t.workspaceId,
            connectionId,
            provider: "github",
            providerRepositoryId: `${Math.floor(Math.random() * 1e9)}`,
            providerOwner: "acme",
            providerName: name,
            providerFullName: `acme/${name}`,
            configuredDefaultRef: defaultRef,
            observedAt: new Date(),
            version: 1,
            createdByUserId: t.userId,
          })
          .returning({
            id: schema.repositoryBindings.id,
            publicId: schema.repositoryBindings.publicId,
            providerRepositoryId:
              schema.repositoryBindings.providerRepositoryId,
          });
        await tx.insert(schema.repositoryBindingHeads).values({
          orgId: t.orgId,
          workspaceId: t.workspaceId,
          connectionId,
          provider: "github",
          providerRepositoryId: binding!.providerRepositoryId,
          currentBindingId: binding!.id,
        });
        return binding!;
      });
    }

    beforeAll(async () => {
      tenant = await support.seedTenant();
      unbound = await support.seedTenant();
      viewerTenant = await support.seedTenant();
      orgIds.push(tenant.orgId, unbound.orgId, viewerTenant.orgId);
      userIds.push(tenant.userId, unbound.userId, viewerTenant.userId);
      await support.seedMember(tenant, "Owner");
      await support.seedMember(unbound, "Owner");
      await support.seedMember(viewerTenant, "Viewer");
      ownerRoleId = (
        await withSystemDb((tx) =>
          tx
            .select({ id: schema.roles.id })
            .from(schema.roles)
            .where(eq(schema.roles.orgId, tenant.orgId)),
        )
      )[0]!.id;
      agent = await support.seedAgent(tenant, { slug: "release-bot" });
      await support.seedAgent(tenant, {
        slug: "gone",
        status: "archived",
        principalStatus: "suspended",
      });
      await support.seedAgent(unbound, { slug: "release-bot" });
      await support.seedAgent(viewerTenant, { slug: "release-bot" });
      bindingPublicId = (await seedBinding(tenant, "core", "main")).publicId;
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        for (const id of orgIds) {
          await tx
            .delete(schema.repositoryBindingHeads)
            .where(eq(schema.repositoryBindingHeads.orgId, id));
          await tx
            .delete(schema.repositoryBindings)
            .where(eq(schema.repositoryBindings.orgId, id));
          await tx
            .delete(schema.roleGrants)
            .where(eq(schema.roleGrants.orgId, id));
        }
      });
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    beforeEach(() => {
      gh.calls.length = 0;
      gh.branches = ["main"];
      gh.openHeads = [];
      gh.defaultBranch = "main";
    });

    const conflict = (reason: string) => (err: unknown) =>
      isHandlerError(err) && err.code === "conflict" && err.reason === reason;
    const forbidden = (reason: string) => (err: unknown) =>
      isHandlerError(err) && err.code === "forbidden" && err.reason === reason;

    it("commits the file to a new branch cut from the default branch, opens the pull request, and caches the commit on a new version row", async () => {
      const source = SOURCE("release-bot", ["list_runs"]);
      const out = await commit(tenant, {
        agentId: "release-bot",
        branch: "agents/release-bot",
        source,
      });
      expect(out).toMatchObject({
        agentId: agent.publicId,
        version: 1,
        path: ".oxagen/agents/release-bot.toml",
        commitSha: "c0ffee01",
        branch: "agents/release-bot",
        pullRequest: {
          number: 42,
          url: "https://github.com/acme/core/pull/42",
        },
      });
      expect(out.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(gh.calls.map((c) => c.op)).toEqual([
        "createBranch",
        "listPullRequests",
        "putFile",
        "openPullRequest",
      ]);
      expect(gh.calls[0]!.args).toMatchObject({
        branch: "agents/release-bot",
        fromBranch: "main",
      });
      expect(gh.calls[1]!.args).toMatchObject({
        head: "acme:agents/release-bot",
        state: "open",
      });
      expect(gh.calls[2]!.args).toMatchObject({
        owner: "acme",
        repo: "core",
        path: ".oxagen/agents/release-bot.toml",
        branch: "agents/release-bot",
        content: source,
      });
      expect(gh.calls[3]!.args).toMatchObject({
        head: "agents/release-bot",
        base: "main",
      });
      // The default branch was never written.
      expect(gh.calls.filter((c) => c.args.branch === "main")).toEqual([]);

      const read = await runInTenantScope(
        { orgId: tenant.orgId, workspaceId: tenant.workspaceId },
        () =>
          agentGetHandler(
            { agentId: "release-bot" },
            support.ctxFor(tenant, tenant.userId),
          ),
      );
      expect(read.definition).toMatchObject({
        version: 1,
        digest: out.digest,
        commitSha: "c0ffee01",
        branch: "agents/release-bot",
        source,
      });
    });

    it("a second commit to a branch under review puts the file on it, reuses its open pull request, and the version number climbs", async () => {
      gh.branches.push("agents/release-bot");
      gh.openHeads.push("acme:agents/release-bot");
      const out = await commit(tenant, {
        agentId: agent.publicId,
        repositoryId: bindingPublicId,
        branch: "agents/release-bot",
        source: SOURCE("release-bot"),
        message: "tighten the belt",
      });
      expect(out.version).toBe(2);
      expect(out.pullRequest).toEqual({
        number: 42,
        url: "https://github.com/acme/core/pull/42",
      });
      expect(gh.calls.map((c) => c.op)).toEqual([
        "listPullRequests",
        "putFile",
      ]);
      expect(gh.calls[1]!.args).toMatchObject({ message: "tighten the belt" });
    });

    it("a branch that exists with no open pull request gets one opened after the file lands", async () => {
      gh.branches.push("agents/release-bot");
      const out = await commit(tenant, {
        agentId: agent.publicId,
        repositoryId: bindingPublicId,
        branch: "agents/release-bot",
        source: SOURCE("release-bot"),
        message: "reopen after merge",
      });
      expect(out.version).toBe(3);
      expect(gh.calls.map((c) => c.op)).toEqual([
        "listPullRequests",
        "putFile",
        "openPullRequest",
      ]);
      expect(gh.calls[2]!.args).toMatchObject({ title: "reopen after merge" });
    });

    it("refuses the configured default ref and the repository's default branch without touching GitHub", async () => {
      await expect(
        commit(tenant, {
          agentId: "release-bot",
          branch: "main",
          source: SOURCE("release-bot"),
        }),
      ).rejects.toSatisfy(conflict("branch_is_default"));
      gh.defaultBranch = "trunk";
      await expect(
        commit(tenant, {
          agentId: "release-bot",
          branch: "trunk",
          source: SOURCE("release-bot"),
        }),
      ).rejects.toSatisfy(conflict("branch_is_default"));
      expect(gh.calls).toEqual([]);
    });

    it("refuses a file with the wrong schema or another agent's slug, and a retired agent", async () => {
      await expect(
        commit(tenant, {
          agentId: "release-bot",
          branch: "agents/x",
          source: 'schema = "agent-definition/v9"\nslug = "release-bot"\n',
        }),
      ).rejects.toSatisfy(conflict("definition_schema"));
      await expect(
        commit(tenant, {
          agentId: "release-bot",
          branch: "agents/x",
          source: SOURCE("other"),
        }),
      ).rejects.toSatisfy(conflict("definition_slug"));
      await expect(
        commit(tenant, {
          agentId: "gone",
          branch: "agents/x",
          source: SOURCE("gone"),
        }),
      ).rejects.toSatisfy(conflict("agent_retired"));
      expect(gh.calls).toEqual([]);
    });

    it("needs one repository binding: none is a conflict, two need repositoryId, a wrong id is not_found", async () => {
      await expect(
        commit(unbound, {
          agentId: "release-bot",
          branch: "agents/x",
          source: SOURCE("release-bot"),
        }),
      ).rejects.toSatisfy(conflict("no_repository"));
      const second = await seedBinding(tenant, "docs", "main");
      await expect(
        commit(tenant, {
          agentId: "release-bot",
          branch: "agents/x",
          source: SOURCE("release-bot"),
        }),
      ).rejects.toSatisfy(conflict("repository_ambiguous"));
      await expect(
        commit(tenant, {
          agentId: "release-bot",
          repositoryId: "rpb_0123456789abcdefghjkmn",
          branch: "agents/x",
          source: SOURCE("release-bot"),
        }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isHandlerError(err) &&
          err.code === "not_found" &&
          err.reason === "repository_not_found",
      );
      const out = await commit(tenant, {
        agentId: "release-bot",
        repositoryId: second.publicId,
        branch: "agents/x",
        source: SOURCE("release-bot"),
      });
      expect(gh.calls[2]!.args).toMatchObject({ repo: "docs" });
      expect(out.version).toBe(4);
    });

    it("an org Viewer is refused on a tier-free org, before the file is read", async () => {
      await expect(
        commit(viewerTenant, {
          agentId: "release-bot",
          branch: "agents/x",
          source: 'schema = "wrong"',
        }),
      ).rejects.toSatisfy(forbidden("org_role_required"));
    });

    it("enforces the delegation ceiling for an enterprise org: a tool the committer does not hold is refused, a granted one passes", async () => {
      await expect(
        commit(
          tenant,
          {
            agentId: "release-bot",
            repositoryId: bindingPublicId,
            branch: "agents/ceiling",
            source: SOURCE("release-bot", ["create_api_key"]),
          },
          "enterprise",
        ),
      ).rejects.toSatisfy(forbidden("delegation_ceiling"));
      expect(gh.calls).toEqual([]);

      await withSystemDb((tx) =>
        tx.insert(schema.roleGrants).values({
          orgId: tenant.orgId,
          roleId: ownerRoleId,
          capabilityId: "create_api_key",
          effect: "allow",
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        }),
      );
      const out = await commit(
        tenant,
        {
          agentId: "release-bot",
          repositoryId: bindingPublicId,
          branch: "agents/ceiling",
          source: SOURCE("release-bot", ["create_api_key"]),
        },
        "enterprise",
      );
      expect(out.branch).toBe("agents/ceiling");
      // Below enterprise the same file commits without the check.
      const free = await commit(tenant, {
        agentId: "release-bot",
        repositoryId: bindingPublicId,
        branch: "agents/free",
        source: SOURCE("release-bot", ["revoke_api_key"]),
      });
      expect(free.branch).toBe("agents/free");
    });
  },
);
