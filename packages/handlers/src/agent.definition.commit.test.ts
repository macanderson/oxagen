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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import {
  AGENT_DEFINITION_SCHEMA,
  agentDefinitionCommit,
} from "@oxagen/oxagen/contracts/agent.definition.commit";

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

// Keep the real exports so constants the handler reads, such as
// OXAGEN_PR_LABELS, stay the ones production uses; only the client is faked.
vi.mock("@oxagen/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/github")>()),
  createGitHubClient: vi.fn(() => gh.client),
}));
vi.mock("@oxagen/github/workspace-token", () => ({
  resolveGitHubToken: vi.fn(async () => "ghs_test"),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// When `gate.enabled`, withTenantDb answers the role gate's selects (the API
// key's creator, the principal, the org role) and every other select with no
// row; otherwise it is the real tenant transaction the Postgres block uses.
const gate = vi.hoisted(() => ({
  enabled: false,
  keyCreator: null as string | null,
  roleName: null as string | null,
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const gateTx = () => ({
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === real.schema.apiKeys
            ? gate.keyCreator
              ? [{ createdById: gate.keyCreator }]
              : []
            : table === real.schema.principals
              ? [{ id: "prn_row" }]
              : table === real.schema.principalRoleAssignments && gate.roleName
                ? [{ roleName: gate.roleName }]
                : [];
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: async () => rows,
        };
        return chain;
      },
    }),
  });
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      gate.enabled ? fn(gateTx()) : real.withTenantDb(fn as never),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { makeCTX } from "./test-utils/fixtures";
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

describe("commit_agent_definition: an API-key call acts as the key's creator", () => {
  // A file with the wrong schema: a call past the gate is refused
  // `definition_schema` before anything is read, so the refusal names which
  // side of the gate the call stopped on.
  const input = agentDefinitionCommit.input.parse({
    agentId: "release-bot",
    branch: "agents/x",
    source: 'schema = "wrong"',
  });
  const keyCtx = makeCTX({ userId: null, apiKeyId: "aky_row", surface: "mcp" });
  const refusal = async () => {
    const err = await agentDefinitionCommitHandler(input, keyCtx).catch(
      (e: unknown) => e,
    );
    return isHandlerError(err) ? { code: err.code, reason: err.reason } : err;
  };

  beforeEach(() => {
    gate.enabled = true;
    gate.keyCreator = "usr_creator";
    gate.roleName = null;
  });
  afterEach(() => {
    gate.enabled = false;
  });

  it("passes the gate for a creator who is an org Member", async () => {
    gate.roleName = "Member";
    await expect(refusal()).resolves.toEqual({
      code: "conflict",
      reason: "definition_schema",
    });
  });

  it("refuses a key whose creator is an org Viewer (negative)", async () => {
    gate.roleName = "Viewer";
    await expect(refusal()).resolves.toEqual({
      code: "forbidden",
      reason: "org_role_required",
    });
  });

  it("refuses a key with no creator (negative)", async () => {
    gate.keyCreator = null;
    gate.roleName = "Owner";
    await expect(refusal()).resolves.toEqual({
      code: "forbidden",
      reason: "no_principal",
    });
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

    async function seedBinding(
      t: Tenant,
      name: string,
      defaultRef: string,
      role: "main" | "linked" = "main",
    ) {
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
            createdById: t.userId,
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
          role,
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
        slug: "claude-bot",
        harness: "claude-code",
      });
      await support.seedAgent(tenant, { slug: "codex-bot", harness: "codex" });
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
        // A custom-harness agent reads no subagent file.
        generatedPath: null,
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

    // #3501: an edit reaches the harness. A Claude Code agent's subagent file
    // is regenerated beside the definition on the same branch; a Codex agent
    // gets the definition alone. agent.definition.commit.harness.test.ts
    // covers Cursor, Stella and the other harnesses without Postgres.
    it("regenerates the subagent file for a Claude Code agent and writes only the definition for a Codex agent", async () => {
      const claude = await commit(tenant, {
        agentId: "claude-bot",
        repositoryId: bindingPublicId,
        branch: "agents/claude-bot",
        source: SOURCE("claude-bot"),
      });
      expect(claude.generatedPath).toBe(".claude/agents/claude-bot.md");
      expect(
        gh.calls.filter((c) => c.op === "putFile").map((c) => c.args.path),
      ).toEqual([
        ".oxagen/agents/claude-bot.toml",
        ".claude/agents/claude-bot.md",
      ]);

      gh.calls.length = 0;
      const codex = await commit(tenant, {
        agentId: "codex-bot",
        repositoryId: bindingPublicId,
        branch: "agents/codex-bot",
        source: SOURCE("codex-bot"),
      });
      expect(codex.generatedPath).toBeNull();
      expect(
        gh.calls.filter((c) => c.op === "putFile").map((c) => c.args.path),
      ).toEqual([".oxagen/agents/codex-bot.toml"]);
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
      expect(gh.calls[2]!.args).toMatchObject({
        title: "reopen after merge",
        labels: ["no-issue"],
      });
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

    it("a refs/- or heads/-qualified default branch is refused by the input the kernel parses, and GitHub is never called", () => {
      // kernel.ts parses `cap.input` before the handler runs, so the handler
      // never sees a name its default-branch comparison would miss.
      for (const branch of ["refs/heads/main", "heads/main"]) {
        const parsed = agentDefinitionCommit.input.safeParse({
          agentId: "release-bot",
          branch,
          source: SOURCE("release-bot"),
        });
        expect(parsed.success, branch).toBe(false);
      }
      expect(gh.calls).toEqual([]);
    });

    it.each([
      "[budget",
      "budget = { per_run_micros = nan }",
      "budget = { per_day_micros = 0 }",
    ])(
      "refuses invalid source before GitHub or a version write: %s",
      async (tail) => {
        await expect(
          commit(tenant, {
            agentId: "release-bot",
            branch: "agents/invalid",
            source: `schema = "${AGENT_DEFINITION_SCHEMA}"\nslug = "release-bot"\n${tail}`,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(gh.calls).toEqual([]);
      },
    );

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
          createdById: tenant.userId,
          updatedById: tenant.userId,
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

    it("two saves on one agent in the same instant both get a version row: the number is taken in the inserting transaction and a collision is retried", async () => {
      const before = await withSystemDb((tx) =>
        tx
          .select({ version: schema.agentVersions.version })
          .from(schema.agentVersions)
          .where(eq(schema.agentVersions.agentId, agent.id)),
      );
      const [a, b] = await Promise.all(
        ["agents/race-a", "agents/race-b"].map((branch) =>
          commit(tenant, {
            agentId: "release-bot",
            repositoryId: bindingPublicId,
            branch,
            source: SOURCE("release-bot"),
          }),
        ),
      );
      expect(a!.version).not.toBe(b!.version);
      const after = await withSystemDb((tx) =>
        tx
          .select({
            version: schema.agentVersions.version,
            commitSha: schema.agentVersions.commitSha,
          })
          .from(schema.agentVersions)
          .where(eq(schema.agentVersions.agentId, agent.id)),
      );
      expect(after).toHaveLength(before.length + 2);
      const max = Math.max(...before.map((r) => r.version));
      expect([a!.version, b!.version].sort()).toEqual([max + 1, max + 2]);
      expect(after.map((r) => r.commitSha)).toEqual(
        expect.arrayContaining([a!.commitSha, b!.commitSha]),
      );
    });

    // §10.1 / ADR-099: a workspace may hold any number of `linked` heads
    // beside its one `main`. Only the main repository carries the `.oxagen/`
    // tree a definition is committed to, so a linked head is invisible to
    // this resolver — a workspace whose only head is linked has no repository
    // to commit to, exactly as one with no head at all.
    it("does not resolve a linked repository: a workspace with only a linked head still has no_repository", async () => {
      await seedBinding(unbound, "sidecar", "main", "linked");
      await expect(
        commit(unbound, {
          agentId: "release-bot",
          branch: "agents/x",
          source: SOURCE("release-bot"),
        }),
      ).rejects.toSatisfy(conflict("no_repository"));
    });
  },
);
