// The workspace repository model against a real Postgres (ADR-099, ADR-212).
//
// A workspace binds its main repository and gets one head with the role
// `steering`. Linking a second repository writes no head. `link_repository`
// opens a steering PR that adds the repository to workspace.toml. When that PR
// merges, the steering sync calls the link reconciler, and the reconciler
// writes the linked head. Unlinking works the same way in reverse when
// workspace.toml lists the repository. A legacy head that workspace.toml does
// not list is deleted at once.
//
// The tests cover these rules:
//   - The main head cannot be unlinked.
//   - Another workspace's main repository cannot be linked.
//   - A repository that is main nowhere links to two workspaces.
//   - Every reader of "the main repository" still answers the steering head
//     while a linked head sits beside it.
//   - A repository linked anywhere cannot become a main repository.
//   - A workspace with GitHub attached and no main head cannot link.
//   - The store's trigger refuses, by constraint name, the writes the
//     handlers refuse by sentence.
//
// The tests run wherever DATABASE_URL points at a migrated database. CI's
// `unit` lanes migrate Postgres with Atlas first. A run without DATABASE_URL
// skips the file. afterAll removes every row the tests write.
//
// `create_workspace` binds no repository (lane S1, #4450). So each workspace
// here is created, given the GitHub connection the install callback attaches,
// and bound through `bind_main_repository`. The steering repo job is a spy,
// so nothing here needs a live Inngest.
//
// The fixture mirrors organization.pg.test.ts: an enterprise org, an Admin
// with a principal and the seeded Admin role, and a first workspace the
// create calls are scoped to. Fixtures answer GitHub. One installation on
// `acme` sees every repository, and a repository's id is a pure function of
// its owner and name. Two reads of one repository agree, and two workspaces
// that ask for the same repository collide the way two real ones would.
//
// A fake steering host holds each workspace's steering repository in memory:
// workspace.toml on the production branch, the branches the handlers write,
// and the open steering PRs. Merging a steering PR copies its branch to the
// production branch. The test then calls the reconciler with the lists before
// and after the merge, the way the steering sync does.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import {
  readGitHubConnection,
  type SteeringRepository,
} from "./context.steering.github";
import { readMainRepositoryProvider } from "./context.steering.host";
import { readMainBoundRepository } from "./context.steering.published.get";
import { GITHUB_PROVIDER } from "./repository.github-connection";
import {
  createRepositoryLinkHandler,
  readWorkspaceNames,
  type RepositorySteeringHost,
} from "./repository.link";
import { createLinkReconciler } from "./repository.link.reconcile";
import { linkRepositoryHead } from "./repository.link.write";
import { repositoryListHandler } from "./repository.list";
import {
  createMainRepositoryBindHandler,
  repositoryHeadConflict,
} from "./repository.main.bind";
import { createMainRepositoryGetHandler } from "./repository.main.get";
import { createRepositoryUnlinkHandler } from "./repository.unlink";
import {
  listedRepositories,
  readWorkspaceToml,
} from "./repository.workspace-toml";
import {
  createWorkspaceCreateHandler,
  type WorkspaceCreateDeps,
} from "./workspace.create";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("workspace repositories against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const orgSlug = `m0repo-${tag}`;
  const coreWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  /** A repository id that is the same every time the fixture is asked. */
  const repoId = (owner: string, name: string) =>
    `${tag}:${owner.toLowerCase()}/${name.toLowerCase()}`;

  const github = {
    candidates: async () => [
      {
        installationId: "555",
        accountLogin: "acme",
        accountType: "Organization",
        avatarUrl: null,
        repositorySelection: "all",
      },
    ],
    repository: async (
      _installationId: string,
      owner: string,
      name: string,
    ) => ({
      id: repoId(owner, name),
      owner,
      name,
      fullName: `${owner}/${name}`,
      htmlUrl: `https://github.com/${owner}/${name}`,
      defaultBranch: "main",
    }),
  };

  // ── the fake steering host ───────────────────────────────────────────────
  interface FakeSteeringRepo {
    /** workspace.toml on the production branch, or null when it is missing. */
    production: string | null;
    /** workspace.toml on each branch the handlers created. */
    branches: Map<string, string | null>;
    /** The open steering PRs, keyed by their head branch. */
    open: Map<string, { number: number; htmlUrl: string; body: string }>;
  }
  const steeringRepos = new Map<string, FakeSteeringRepo>();
  /** Every steering PR the host opened, in order. */
  const opened: { steeringRepo: string; head: string; number: number }[] = [];
  let nextPullRequest = 1;

  /** The steering repository the fake resolves for a workspace. */
  const steeringRepoOf = (workspaceId: string): SteeringRepository => ({
    provider: "github",
    owner: "acme",
    repo: `steering-${workspaceId}`,
    fullName: `acme/steering-${workspaceId}`,
    currentFullName: `acme/steering-${workspaceId}`,
    defaultBranch: "main",
  });
  const stateOf = (repo: SteeringRepository): FakeSteeringRepo => {
    const known = steeringRepos.get(repo.fullName);
    if (known) return known;
    const fresh: FakeSteeringRepo = {
      production: null,
      branches: new Map(),
      open: new Map(),
    };
    steeringRepos.set(repo.fullName, fresh);
    return fresh;
  };
  const productionOf = (workspaceId: string) =>
    stateOf(steeringRepoOf(workspaceId)).production;

  const steering: RepositorySteeringHost = {
    resolveRepository: async (scope) => steeringRepoOf(scope.workspaceId),
    readFile: async (repo, path, ref) => {
      if (path !== WORKSPACE_TOML_PATH) return null;
      const state = stateOf(repo);
      if (ref === repo.defaultBranch) return state.production;
      return state.branches.get(ref) ?? null;
    },
    ensureBranch: async (repo, branch, fromBranch) => {
      if (fromBranch !== repo.defaultBranch)
        throw new Error(`a steering PR branch starts from ${fromBranch}`);
      const state = stateOf(repo);
      // An existing branch is reused, the way the real host reuses it.
      if (!state.branches.has(branch))
        state.branches.set(branch, state.production);
    },
    putFile: async (repo, args) => {
      if (args.path !== WORKSPACE_TOML_PATH)
        throw new Error(`the handlers wrote ${args.path}`);
      const state = stateOf(repo);
      if (!state.branches.has(args.branch))
        throw new Error(`no branch ${args.branch}`);
      state.branches.set(args.branch, args.content);
      return { commitSha: `sha-${args.branch}` };
    },
    findOpenPullRequest: async (repo, args) => {
      if (args.base !== repo.defaultBranch) return null;
      return stateOf(repo).open.get(args.head) ?? null;
    },
    openPullRequest: async (repo, args) => {
      if (args.base !== repo.defaultBranch)
        throw new Error(`a steering PR targets ${args.base}`);
      const state = stateOf(repo);
      if (!state.branches.has(args.head))
        throw new Error(`no branch ${args.head}`);
      // A second open PR for one branch is a defect in the handler.
      if (state.open.has(args.head))
        throw new Error(`a steering PR from ${args.head} is already open`);
      const number = nextPullRequest;
      nextPullRequest += 1;
      const htmlUrl = `https://github.com/${repo.fullName}/pull/${number}`;
      state.open.set(args.head, { number, htmlUrl, body: args.body });
      opened.push({ steeringRepo: repo.fullName, head: args.head, number });
      return { number, htmlUrl };
    },
  };

  /**
   * Merge an open steering PR. The branch replaces workspace.toml on the
   * production branch, and the branch is deleted the way GitHub deletes a
   * merged one. Returns the lists before and after, as the sync reads them.
   */
  const mergeSteeringPr = (workspaceId: string, number: number) => {
    const state = stateOf(steeringRepoOf(workspaceId));
    const entry = [...state.open.entries()].find(
      ([, pr]) => pr.number === number,
    );
    if (!entry) throw new Error(`no open steering PR #${number}`);
    const [head] = entry;
    const prior = listedRepositories(readWorkspaceToml(state.production));
    const merged = state.branches.get(head) ?? null;
    state.production = merged;
    state.open.delete(head);
    state.branches.delete(head);
    const current = listedRepositories(readWorkspaceToml(merged));
    if (current === null)
      throw new Error(`steering PR #${number} left an unreadable workspace.toml`);
    return { prior, current };
  };

  // The steering repo job's trigger. A spy, so no create needs a live Inngest.
  const requestProvision = vi.fn<WorkspaceCreateDeps["requestProvision"]>(
    async () => {},
  );
  const createWorkspace = createWorkspaceCreateHandler({ requestProvision });
  const linkRepository = createRepositoryLinkHandler({
    repository: github.repository,
    steering,
    workspaceNames: readWorkspaceNames,
  });
  const unlinkRepository = createRepositoryUnlinkHandler({ steering });
  const reconcileLinks = createLinkReconciler({
    repository: github.repository,
  });
  const bindMainRepository = createMainRepositoryBindHandler(github);
  const getMainRepository = createMainRepositoryGetHandler({
    githubUrls: () => null,
  });

  const ctx = (workspaceId: string): CapabilityContext => ({
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  });
  const inWorkspace = <T>(workspaceId: string, fn: () => Promise<T>) =>
    runInTenantScope({ orgId, workspaceId }, fn);
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.catch((e) => e);
    if (!isHandlerError(err))
      throw new Error(`expected a HandlerError, got ${err}`);
    return { code: err.code, reason: err.reason };
  };

  /**
   * A workspace through `create_workspace`. `deprecatedMainRepo` names the
   * repository an older caller would still send, which the handler ignores.
   */
  const create = (slug: string, deprecatedMainRepo?: string) =>
    inWorkspace(coreWorkspaceId, () =>
      createWorkspace(
        workspaceCreate.input.parse({
          name: slug,
          slug,
          ...(deprecatedMainRepo === undefined
            ? {}
            : { mainRepo: { owner: "acme", name: deprecatedMainRepo } }),
        }),
        ctx(coreWorkspaceId),
      ),
    );
  /** `link_repository` alone: the steering PR, and no head. */
  const propose = (workspaceId: string, repo: string) =>
    inWorkspace(workspaceId, () =>
      linkRepository(
        repositoryLink.input.parse({ owner: "acme", name: repo }),
        ctx(workspaceId),
      ),
    );
  /** The steering sync's reconcile, run in the workspace's tenant scope. */
  const reconcile = (
    workspaceId: string,
    change: { prior: string[] | null; current: string[] },
  ) =>
    inWorkspace(workspaceId, () =>
      reconcileLinks({ orgId, workspaceId }, { ...change, now: new Date() }),
    );
  const bind = (workspaceId: string, repo: string) =>
    inWorkspace(workspaceId, () =>
      bindMainRepository(
        repositoryMainBind.input.parse({ owner: "acme", name: repo }),
        ctx(workspaceId),
      ),
    );
  const unlink = (workspaceId: string, bindingId: string) =>
    inWorkspace(workspaceId, () =>
      unlinkRepository(
        repositoryUnlink.input.parse({ bindingId }),
        ctx(workspaceId),
      ),
    );
  const list = (workspaceId: string) =>
    inWorkspace(workspaceId, () =>
      repositoryListHandler(repositoryList.input.parse({}), ctx(workspaceId)),
    );
  const workspaceIdBySlug = async (slug: string) => {
    const [row] = await withSystemDb((tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.orgId, orgId),
            eq(schema.workspaces.slug, slug),
          ),
        ),
    );
    if (!row) throw new Error(`no workspace ${slug}`);
    return row.id;
  };
  /** The constraint name a refused statement carries, wherever the driver nested it. */
  const constraintOf = (err: unknown): string | null => {
    for (let e: unknown = err, hops = 0; e != null && hops < 5; hops++) {
      const row = e as { constraint_name?: unknown; cause?: unknown };
      if (typeof row.constraint_name === "string") return row.constraint_name;
      e = row.cause;
    }
    return null;
  };
  const internalId = async (publicId: string) => {
    const [row] = await withSystemDb((tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.publicId, publicId)),
    );
    if (!row) throw new Error(`no workspace ${publicId}`);
    return row.id;
  };
  /**
   * What the GitHub install callback leaves on a workspace: a connection
   * carrying the installation. `bind_main_repository` marks it connected.
   */
  const attachGithub = (workspaceId: string) =>
    withSystemDb((tx) =>
      tx.insert(schema.sourceConnections).values({
        orgId,
        workspaceId,
        connectorId: GITHUB_PROVIDER,
        displayName: "GitHub",
        authScheme: "oauth2_authorization_code",
        deliveryMethod: "webhook",
        deliveryConfig: { installationId: "555" },
        status: "pending_setup",
        createdById: userId,
      }),
    );
  /** A workspace with its main repository: create, attach GitHub, and bind. */
  const createWithMain = async (slug: string, repo: string) => {
    const workspace = await create(slug);
    const id = await internalId(workspace.publicId);
    await attachGithub(id);
    const main = await bind(id, repo);
    return { id, main };
  };
  const headsOf = (workspaceId: string) =>
    withSystemDb((tx) =>
      tx
        .select({
          role: schema.repositoryBindingHeads.role,
          providerRepositoryId:
            schema.repositoryBindingHeads.providerRepositoryId,
        })
        .from(schema.repositoryBindingHeads)
        .where(eq(schema.repositoryBindingHeads.workspaceId, workspaceId))
        .orderBy(schema.repositoryBindingHeads.role),
    );
  const headsFor = async (workspaceId: string, repo: string) =>
    (await headsOf(workspaceId)).filter(
      (h) => h.providerRepositoryId === repoId("acme", repo),
    );
  const bindingsOf = (workspaceId: string, repo: string) =>
    withSystemDb((tx) =>
      tx
        .select({
          publicId: schema.repositoryBindings.publicId,
          version: schema.repositoryBindings.version,
        })
        .from(schema.repositoryBindings)
        .where(
          and(
            eq(schema.repositoryBindings.workspaceId, workspaceId),
            eq(
              schema.repositoryBindings.providerRepositoryId,
              repoId("acme", repo),
            ),
          ),
        ),
    );

  /**
   * Link a repository the way it happens in production. The handler opens a
   * steering PR and writes no head. The PR merges, and the reconcile writes
   * the head. Returns the handler's answer with the binding id and role the
   * list reads back.
   */
  const link = async (workspaceId: string, repo: string) => {
    const proposed = await propose(workspaceId, repo);
    expect(proposed).toMatchObject({
      fullName: `acme/${repo}`,
      status: "proposed",
      steeringPullRequest: { reused: false },
    });
    const pullRequest = proposed.steeringPullRequest;
    if (!pullRequest) throw new Error("the link opened no steering PR");
    // The open PR links nothing.
    expect(await headsFor(workspaceId, repo)).toEqual([]);
    const change = mergeSteeringPr(workspaceId, pullRequest.number);
    await expect(reconcile(workspaceId, change)).resolves.toEqual({
      linked: [`acme/${repo}`],
      unlinked: [],
      findings: [],
    });
    const row = (await list(workspaceId)).repositories.find(
      (r) => r.fullName === `acme/${repo}`,
    );
    if (!row) throw new Error(`the reconcile did not link acme/${repo}`);
    return { ...proposed, bindingId: row.bindingId, role: row.role };
  };
  /**
   * A linked head written straight to the store, the way links were written
   * before workspace.toml listed them.
   */
  const seedLegacyHead = (workspaceId: string, repo: string) =>
    inWorkspace(workspaceId, () =>
      linkRepositoryHead(
        { orgId, workspaceId },
        { owner: "acme", name: repo },
        { userId, now: new Date() },
        { repository: github.repository },
      ),
    );

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        email: `m0repo-${tag}@handlers.test`,
        displayName: "Dana Okafor",
        status: "active",
      });
      await tx.insert(schema.organizations).values({
        id: orgId,
        name: `M0 repositories ${tag}`,
        slug: orgSlug,
        namespace: `m${tag.slice(0, 5)}`,
        // The enterprise tier is the one the kernel enforces roles for.
        planType: "enterprise",
        status: "active",
      });
      await tx.insert(schema.workspaces).values({
        id: coreWorkspaceId,
        orgId,
        name: "Core",
        slug: "core",
        namespace: "core",
      });
      await tx.insert(schema.orgUsers).values({
        orgId,
        userId,
        role: "admin",
        joinedAt: new Date(),
      });
      const [principal] = await tx
        .insert(schema.principals)
        .values({
          orgId,
          kind: "human",
          displayName: "Dana Okafor",
          status: "active",
          parentUserId: userId,
        })
        .returning({ id: schema.principals.id });
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId,
          scopeKind: "org",
          name: "Admin",
          isSystemDefault: true,
        })
        .returning({ id: schema.roles.id });
      if (!principal || !role)
        throw new Error("fixture insert returned no row");
      await tx.insert(schema.principalRoleAssignments).values({
        principalId: principal.id,
        roleId: role.id,
        orgId,
      });
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const roleIds = (
        await tx
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(eq(schema.roles.orgId, orgId))
      ).map((r) => r.id);
      if (roleIds.length > 0) {
        await tx
          .delete(schema.principalRoleAssignments)
          .where(inArray(schema.principalRoleAssignments.roleId, roleIds));
        await tx
          .delete(schema.roleGrants)
          .where(inArray(schema.roleGrants.roleId, roleIds));
      }
      await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
      await tx
        .delete(schema.principals)
        .where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.orgUsers).where(eq(schema.orgUsers.orgId, orgId));
      const wsIds = (
        await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, orgId))
      ).map((w) => w.id);
      if (wsIds.length > 0) {
        await tx
          .delete(schema.workspaceUsers)
          .where(inArray(schema.workspaceUsers.workspaceId, wsIds));
        await tx
          .delete(schema.workspaceSlugHistory)
          .where(inArray(schema.workspaceSlugHistory.workspaceId, wsIds));
      }
      // The heads and bindings the binds, the reconciles, and the seeded
      // legacy links wrote.
      await tx
        .delete(schema.repositoryBindingHeads)
        .where(eq(schema.repositoryBindingHeads.orgId, orgId));
      await tx
        .delete(schema.repositoryBindings)
        .where(eq(schema.repositoryBindings.orgId, orgId));
      await tx
        .delete(schema.sourceConnections)
        .where(eq(schema.sourceConnections.orgId, orgId));
      await tx
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.orgId, orgId));
      await tx
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
    await closeDatabase();
  });

  it("walks the model: bind a main repo, link a second through a steering PR, the readers keep answering main, unlink the linked one through a steering PR, refuse to unlink main, refuse another workspace's main, share a repository that is nobody's main", async () => {
    // ── bind: one head, role steering ────────────────────────────────────────
    const alpha = await createWithMain("alpha", "alpha");
    expect(alpha.main.fullName).toBe("acme/alpha");
    const alphaId = alpha.id;
    expect(await headsOf(alphaId)).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "alpha") },
    ]);

    const beta = await createWithMain("beta", "beta");
    const betaId = beta.id;
    expect(await headsOf(betaId)).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "beta") },
    ]);

    // A third workspace created with alpha's main repository as its
    // deprecated `mainRepo` is created with no head: the handler ignores the
    // field and starts the steering repo job instead.
    const gamma = await create("gamma", "alpha");
    expect(gamma.steering_repo).toEqual({ status: "provisioning" });
    const gammaId = await internalId(gamma.publicId);
    expect(await headsOf(gammaId)).toEqual([]);
    // Binding alpha's main repository afterwards is refused by the global
    // claim, and no head is left behind.
    await attachGithub(gammaId);
    await expect(refusal(bind(gammaId, "alpha"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_claimed",
    });
    expect(await headsOf(gammaId)).toEqual([]);
    // Each create started its workspace's steering repo job.
    expect(requestProvision).toHaveBeenCalledTimes(3);

    // ── link a second repo: a steering PR, and no head yet ────────────────
    // Alpha's steering repository has no workspace.toml, so the steering PR
    // creates one that lists the repository.
    expect(productionOf(alphaId)).toBeNull();
    const openedBefore = opened.length;
    const proposed = await propose(alphaId, "shared");
    expect(proposed).toMatchObject({
      fullName: "acme/shared",
      defaultRef: "main",
      status: "proposed",
      steeringPullRequest: { reused: false },
    });
    const pullRequest = proposed.steeringPullRequest;
    if (!pullRequest) throw new Error("the link opened no steering PR");
    expect(opened.slice(openedBefore)).toEqual([
      {
        steeringRepo: steeringRepoOf(alphaId).fullName,
        head: "workspace/link-acme-shared",
        number: pullRequest.number,
      },
    ]);
    expect(await headsOf(alphaId)).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "alpha") },
    ]);

    // A second call before the merge reuses the open steering PR.
    const repeated = await propose(alphaId, "shared");
    expect(repeated).toMatchObject({
      status: "proposed",
      steeringPullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
        reused: true,
      },
    });
    expect(opened).toHaveLength(openedBefore + 1);
    expect(await headsOf(alphaId)).toHaveLength(1);

    // ── the steering PR merges, and the reconcile writes the head ────────
    const change = mergeSteeringPr(alphaId, pullRequest.number);
    expect(change).toEqual({
      prior: [],
      current: ["github.com/acme/shared"],
    });
    // The new workspace.toml names the organization and workspace slugs.
    const merged = productionOf(alphaId);
    expect(merged).toContain(`organization = "${orgSlug}"`);
    expect(merged).toContain('workspace = "alpha"');
    await expect(reconcile(alphaId, change)).resolves.toEqual({
      linked: ["acme/shared"],
      unlinked: [],
      findings: [],
    });
    expect(await headsOf(alphaId)).toEqual([
      { role: "linked", providerRepositoryId: repoId("acme", "shared") },
      { role: "steering", providerRepositoryId: repoId("acme", "alpha") },
    ]);
    const listed = await list(alphaId);
    expect(
      listed.repositories.map((r) => [r.role, r.fullName, r.connectionLive]),
    ).toEqual([
      ["main", "acme/alpha", true],
      ["linked", "acme/shared", true],
    ]);
    expect(listed.repositories[0]?.bindingId).toBe(alpha.main.bindingId);
    const sharedRow = listed.repositories.find(
      (r) => r.fullName === "acme/shared",
    );
    if (!sharedRow) throw new Error("acme/shared is not listed");
    const shared = { bindingId: sharedRow.bindingId };

    // ── the readers that resolve THE main repository filter on the steering role
    // With a linked head beside the main one, a reader that ignored the
    // column could answer either. Both keep answering alpha.
    const main = await inWorkspace(alphaId, () =>
      getMainRepository({}, ctx(alphaId)),
    );
    expect(main.repository).toMatchObject({
      bindingId: alpha.main.bindingId,
      fullName: "acme/alpha",
    });
    await expect(
      inWorkspace(alphaId, () =>
        readGitHubConnection({ orgId, workspaceId: alphaId }),
      ),
    ).resolves.toMatchObject({
      source: "binding",
      approvedFullName: "acme/alpha",
      approvedDefaultRef: "main",
    });

    // ── another workspace's main repository cannot be linked ─────────────
    // Every refusal comes before the handler touches the steering repository,
    // so none of them opens a steering PR.
    const openedAfterLink = opened.length;
    await expect(refusal(propose(alphaId, "beta"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_claimed",
    });
    // This workspace's own main is a different refusal, and an existing link
    // is a third.
    await expect(refusal(propose(alphaId, "alpha"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo",
    });
    await expect(refusal(propose(alphaId, "shared"))).resolves.toEqual({
      code: "conflict",
      reason: "repository_already_linked",
    });
    expect(opened).toHaveLength(openedAfterLink);

    // ── a repository that is main in neither links to both ───────────────
    // Beta's steering PR and reconcile are its own.
    const sharedInBeta = await link(betaId, "shared");
    expect(sharedInBeta.role).toBe("linked");
    expect(await headsOf(betaId)).toHaveLength(2);
    expect(await headsOf(alphaId)).toHaveLength(2);

    // ── unlink the linked one: a steering PR removes the entry ───────────
    // workspace.toml lists the repository, so the handler proposes and the
    // head stays until the PR merges.
    const proposedUnlink = await unlink(alphaId, shared.bindingId);
    expect(proposedUnlink).toMatchObject({
      bindingId: shared.bindingId,
      fullName: "acme/shared",
      status: "proposed",
      unlinkedAt: null,
      steeringPullRequest: { reused: false },
    });
    const unlinkPullRequest = proposedUnlink.steeringPullRequest;
    if (!unlinkPullRequest) throw new Error("the unlink opened no steering PR");
    expect(opened.slice(-1)).toEqual([
      {
        steeringRepo: steeringRepoOf(alphaId).fullName,
        head: "workspace/unlink-acme-shared",
        number: unlinkPullRequest.number,
      },
    ]);
    expect(await headsOf(alphaId)).toHaveLength(2);

    // The merge drops the entry, and the reconcile deletes the head. The main
    // head is untouched, and the binding version stays.
    const removal = mergeSteeringPr(alphaId, unlinkPullRequest.number);
    expect(removal).toEqual({
      prior: ["github.com/acme/shared"],
      current: [],
    });
    await expect(reconcile(alphaId, removal)).resolves.toEqual({
      linked: [],
      unlinked: ["acme/shared"],
      findings: [],
    });
    expect(await headsOf(alphaId)).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "alpha") },
    ]);
    expect(await bindingsOf(alphaId, "shared")).toEqual([
      { publicId: shared.bindingId, version: 1 },
    ]);
    // Beta's link to the same repository is its own head and is untouched.
    expect(await headsOf(betaId)).toHaveLength(2);

    // ── unlink main: refused, nothing moves ──────────────────────────────
    const openedBeforeRefusals = opened.length;
    await expect(
      refusal(unlink(alphaId, alpha.main.bindingId)),
    ).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_unlink_refused",
    });
    expect(await headsOf(alphaId)).toHaveLength(1);
    // A head cannot be unlinked twice, or from a workspace that never saw it.
    await expect(refusal(unlink(alphaId, shared.bindingId))).resolves.toEqual({
      code: "not_found",
      reason: "repository_not_linked",
    });
    await expect(
      refusal(unlink(betaId, alpha.main.bindingId)),
    ).resolves.toEqual({
      code: "not_found",
      reason: "repository_not_linked",
    });
    expect(opened).toHaveLength(openedBeforeRefusals);

    // ── re-link: the retained version is reused, no second version 1 ────
    // The merged link PR is closed, so the re-link opens a new one.
    const again = await link(alphaId, "shared");
    expect(again.bindingId).toBe(shared.bindingId);
    expect(again.steeringPullRequest?.number).not.toBe(pullRequest.number);
    expect(await bindingsOf(alphaId, "shared")).toEqual([
      { publicId: shared.bindingId, version: 1 },
    ]);
    expect(await headsOf(alphaId)).toHaveLength(2);
  });

  it("reconciles only a change: the same list twice writes nothing, an unknown prior list removes nothing, and an entry the sync cannot link becomes a warning", async () => {
    // Left by the walk above: alpha has its main head and a linked head for
    // `shared`, and its workspace.toml lists `shared`.
    const alphaId = await workspaceIdBySlug("alpha");
    const heads = await headsOf(alphaId);
    expect(heads).toEqual([
      { role: "linked", providerRepositoryId: repoId("acme", "shared") },
      { role: "steering", providerRepositoryId: repoId("acme", "alpha") },
    ]);
    const listed = listedRepositories(readWorkspaceToml(productionOf(alphaId)));
    expect(listed).toEqual(["github.com/acme/shared"]);
    if (listed === null) throw new Error("alpha's workspace.toml is unreadable");
    const nothing = { linked: [], unlinked: [], findings: [] };

    // ── the same list twice: every entry already has its head ───────────
    await expect(
      reconcile(alphaId, { prior: listed, current: listed }),
    ).resolves.toEqual(nothing);
    expect(await headsOf(alphaId)).toEqual(heads);

    // ── no prior list: nothing is removed ────────────────────────────────
    // An empty current list would drop `shared` if the prior list were
    // known. With no prior list, the reconcile cannot tell, so it keeps it.
    await expect(
      reconcile(alphaId, { prior: null, current: [] }),
    ).resolves.toEqual(nothing);
    expect(await headsOf(alphaId)).toEqual(heads);

    // ── entries the sync cannot link: one warning each, no head ─────────
    // The workspace's own steering repository, a GitLab repository, and
    // another workspace's steering repository.
    const warning = {
      level: "warning",
      path: WORKSPACE_TOML_PATH,
      lineageId: null,
      code: "repository_link",
    };
    await expect(
      reconcile(alphaId, {
        prior: listed,
        current: [
          ...listed,
          "github.com/acme/alpha",
          "gitlab.com/acme/x",
          "github.com/acme/beta",
        ],
      }),
    ).resolves.toEqual({
      linked: [],
      unlinked: [],
      findings: [
        {
          ...warning,
          message: expect.stringContaining(
            "lists github.com/acme/alpha, the workspace's steering repository",
          ),
        },
        {
          ...warning,
          message: expect.stringContaining(
            "lists gitlab.com/acme/x. Oxagen links GitHub repositories only",
          ),
        },
        {
          ...warning,
          message: expect.stringContaining(
            "lists github.com/acme/beta, and Oxagen could not link it (main_repo_claimed)",
          ),
        },
      ],
    });
    expect(await headsOf(alphaId)).toEqual(heads);
  });

  it("holds the rule in the other direction and at the store: a linked repository cannot become a main, a link needs a main first, and the trigger refuses what the pre-checks refuse", async () => {
    // Left by the walk above: alpha (main alpha, linked shared) and beta
    // (main beta, linked shared). `shared` is main nowhere.
    const alphaId = await workspaceIdBySlug("alpha");
    const betaId = await workspaceIdBySlug("beta");

    // ── create with a repository that is linked elsewhere: no head ────────
    // The deprecated `mainRepo` is ignored, so the create succeeds and binds
    // nothing, even for a repository two workspaces link.
    const delta = await create("delta", "shared");
    expect(delta.steering_repo).toEqual({ status: "provisioning" });
    const deltaId = await workspaceIdBySlug("delta");
    expect(await headsOf(deltaId)).toEqual([]);

    // ── the first workspace: GitHub attached, no main head yet ────────────
    // What the install callback leaves behind on the organisation's first
    // workspace before `bind_main_repository` runs (ADR-099 §6).
    await attachGithub(coreWorkspaceId);
    expect(await headsOf(coreWorkspaceId)).toEqual([]);

    // A link before the main: refused before any steering PR opens, and
    // nothing written.
    const openedBefore = opened.length;
    await expect(
      refusal(propose(coreWorkspaceId, "orphan")),
    ).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_unbound",
    });
    expect(opened).toHaveLength(openedBefore);
    expect(await headsOf(coreWorkspaceId)).toEqual([]);

    // Binding a repository other workspaces have linked as this one's main:
    // refused by the pre-check, before the transaction.
    await expect(refusal(bind(coreWorkspaceId, "shared"))).resolves.toEqual({
      code: "conflict",
      reason: "repository_linked_elsewhere",
    });
    expect(await headsOf(coreWorkspaceId)).toEqual([]);

    // ── the trigger, past every handler pre-check ─────────────────────────
    // Direct writes under the system seam, which is how a racing writer
    // looks to the store: the pre-check has passed and only the trigger's
    // repository-keyed lock and read stand between the write and the table.
    const headOf = async (workspaceId: string, repo: string) => {
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ id: schema.repositoryBindingHeads.id })
          .from(schema.repositoryBindingHeads)
          .where(
            and(
              eq(schema.repositoryBindingHeads.workspaceId, workspaceId),
              eq(
                schema.repositoryBindingHeads.providerRepositoryId,
                repoId("acme", repo),
              ),
            ),
          ),
      );
      if (!row) throw new Error(`no head for ${repo} in ${workspaceId}`);
      return row.id;
    };
    const refusedBy = async (
      write: Promise<unknown>,
    ): Promise<{ constraint: string | null; mapped: string | null }> => {
      const err = await write.then(
        () => null,
        (e: unknown) => e,
      );
      if (err === null) throw new Error("the store admitted the write");
      return {
        constraint: constraintOf(err),
        mapped: repositoryHeadConflict(err),
      };
    };
    const betaShared = await headOf(betaId, "shared");
    const betaMain = await headOf(betaId, "beta");

    // A linked head promoted to main while alpha still links the repository.
    await expect(
      refusedBy(
        withSystemDb((tx) =>
          tx
            .update(schema.repositoryBindingHeads)
            .set({ role: "steering" })
            .where(eq(schema.repositoryBindingHeads.id, betaShared)),
        ),
      ),
    ).resolves.toEqual({
      constraint: "repository_binding_heads_main_is_linked_elsewhere",
      mapped: "linked_elsewhere",
    });
    // A linked head moved onto alpha's main repository.
    await expect(
      refusedBy(
        withSystemDb((tx) =>
          tx
            .update(schema.repositoryBindingHeads)
            .set({ providerRepositoryId: repoId("acme", "alpha") })
            .where(eq(schema.repositoryBindingHeads.id, betaShared)),
        ),
      ),
    ).resolves.toEqual({
      constraint: "repository_binding_heads_linked_is_main_elsewhere",
      mapped: "main_elsewhere",
    });
    // A main head moved onto alpha's main repository: the trigger raises the
    // index's own name, before the index itself is consulted.
    await expect(
      refusedBy(
        withSystemDb((tx) =>
          tx
            .update(schema.repositoryBindingHeads)
            .set({ providerRepositoryId: repoId("acme", "alpha") })
            .where(eq(schema.repositoryBindingHeads.id, betaMain)),
        ),
      ),
    ).resolves.toEqual({
      constraint: "repository_binding_heads_main_repository_uq",
      mapped: "main_elsewhere",
    });
    // Nothing moved.
    expect(await headsOf(betaId)).toEqual([
      { role: "linked", providerRepositoryId: repoId("acme", "shared") },
      { role: "steering", providerRepositoryId: repoId("acme", "beta") },
    ]);
    expect(await headsOf(alphaId)).toHaveLength(2);

    // ── and what the rule allows still passes the trigger ────────────────
    // A repository nobody holds becomes the first workspace's main through
    // `bind_main_repository`, and `shared`, main nowhere, links to a third
    // workspace through its own steering PR.
    const bound = await bind(coreWorkspaceId, "orphan");
    expect(bound.fullName).toBe("acme/orphan");
    const third = await link(coreWorkspaceId, "shared");
    expect(third.role).toBe("linked");
    expect(await headsOf(coreWorkspaceId)).toEqual([
      { role: "linked", providerRepositoryId: repoId("acme", "shared") },
      { role: "steering", providerRepositoryId: repoId("acme", "orphan") },
    ]);
  });

  it("reads a head with the steering role as the workspace's steering repository, unlinks a legacy head at once, and a re-bind keeps the role", async () => {
    // Every head that steers carries role `steering`. The bind writes it, and
    // so does S1's provisioned steering repository. Every reader has to
    // answer that head.
    const steers = await createWithMain("steer-ws", "steers");
    const steersId = steers.id;
    expect(await headsOf(steersId)).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "steers") },
    ]);

    // ── every reader answers the steering head ───────────────────────────
    const main = await inWorkspace(steersId, () =>
      getMainRepository({}, ctx(steersId)),
    );
    expect(main.repository).toMatchObject({
      bindingId: steers.main.bindingId,
      fullName: "acme/steers",
    });
    await expect(
      inWorkspace(steersId, () =>
        readGitHubConnection({ orgId, workspaceId: steersId }),
      ),
    ).resolves.toMatchObject({
      source: "binding",
      approvedFullName: "acme/steers",
    });
    await expect(
      inWorkspace(steersId, () =>
        readMainRepositoryProvider({ orgId, workspaceId: steersId }),
      ),
    ).resolves.toBe("github");
    await expect(
      inWorkspace(steersId, () =>
        readMainBoundRepository({ orgId, workspaceId: steersId }),
      ),
    ).resolves.toMatchObject({
      bindingId: steers.main.bindingId,
      fullName: "acme/steers",
      role: "main",
    });
    // The list contract names the steering head `main`.
    const listed = await list(steersId);
    expect(
      listed.repositories.map((r) => [r.role, r.fullName]),
    ).toEqual([["main", "acme/steers"]]);

    // ── link refuses it here and elsewhere ───────────────────────────────
    await expect(refusal(propose(steersId, "steers"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo",
    });
    const other = await createWithMain("steer-other", "steers-other");
    await expect(refusal(propose(other.id, "steers"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_claimed",
    });

    // ── a legacy head with no workspace.toml: the unlink deletes it ──────
    // The steering repository has no workspace.toml, so nothing lists the
    // head, and no steering PR can remove an entry.
    expect(productionOf(steersId)).toBeNull();
    const legacy = await seedLegacyHead(steersId, "steers-legacy");
    expect(legacy.fullName).toBe("acme/steers-legacy");
    expect(await headsFor(steersId, "steers-legacy")).toEqual([
      {
        role: "linked",
        providerRepositoryId: repoId("acme", "steers-legacy"),
      },
    ]);
    const openedBefore = opened.length;
    await expect(
      unlink(steersId, legacy.bindingPublicId),
    ).resolves.toMatchObject({
      bindingId: legacy.bindingPublicId,
      fullName: "acme/steers-legacy",
      status: "unlinked",
      unlinkedAt: expect.any(String),
      steeringPullRequest: null,
    });
    expect(opened).toHaveLength(openedBefore);
    expect(await headsFor(steersId, "steers-legacy")).toEqual([]);

    // ── a link beside the steering head ──────────────────────────────────
    const side = await link(steersId, "steers-side");
    expect(side.role).toBe("linked");
    expect(await headsOf(steersId)).toEqual([
      { role: "linked", providerRepositoryId: repoId("acme", "steers-side") },
      { role: "steering", providerRepositoryId: repoId("acme", "steers") },
    ]);

    // ── unlink refuses it, and a re-bind neither demotes nor duplicates it ──
    await expect(
      refusal(unlink(steersId, steers.main.bindingId)),
    ).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_unlink_refused",
    });
    const rebound = await bind(steersId, "steers");
    expect(rebound.bindingId).toBe(steers.main.bindingId);
    expect(await headsFor(steersId, "steers")).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "steers") },
    ]);
  });

  it("a workspace left with no main head binds its way out: a linked head is promoted in place, and a version retained from an unlinked head is reused", async () => {
    // The exclusivity migration's demotion leaves this state. A link needs a
    // main head first, so the test deletes the main head to reach it. The
    // workspace is left with a linked head and no main head. Both binds below
    // used to insert a second version-1 binding for a pair that already had
    // one. `repository_bindings_repository_version_uq` refuses that insert.
    // The refusal names no cross-workspace claim, so it reached the operator
    // as a 500 on the one move that gives the workspace a main repository
    // back.
    const dropMainHead = () =>
      withSystemDb((tx) =>
        tx
          .delete(schema.repositoryBindingHeads)
          .where(
            and(
              eq(schema.repositoryBindingHeads.workspaceId, coreWorkspaceId),
              eq(schema.repositoryBindingHeads.role, "steering"),
            ),
          ),
      );

    // ── a linked head, then no main head, then the bind ───────────────────
    const linked = await link(coreWorkspaceId, "promoted");
    expect(linked.role).toBe("linked");
    await dropMainHead();

    const promoted = await bind(coreWorkspaceId, "promoted");
    // The bind reuses the binding version the reconcile wrote. Nothing it
    // records has moved, so only the role changes.
    expect(promoted.bindingId).toBe(linked.bindingId);
    expect(await bindingsOf(coreWorkspaceId, "promoted")).toEqual([
      { publicId: linked.bindingId, version: 1 },
    ]);
    expect(await headsFor(coreWorkspaceId, "promoted")).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "promoted") },
    ]);

    // ── a version retained from an unlinked legacy head ───────────────────
    // workspace.toml lists `shared` and `promoted`, and not `retained`. So the
    // unlink deletes the legacy head at once and opens no steering PR.
    const retained = await seedLegacyHead(coreWorkspaceId, "retained");
    expect(
      listedRepositories(readWorkspaceToml(productionOf(coreWorkspaceId))),
    ).toEqual(["github.com/acme/shared", "github.com/acme/promoted"]);
    const openedBefore = opened.length;
    await expect(
      unlink(coreWorkspaceId, retained.bindingPublicId),
    ).resolves.toMatchObject({
      bindingId: retained.bindingPublicId,
      status: "unlinked",
      steeringPullRequest: null,
    });
    expect(opened).toHaveLength(openedBefore);
    expect(await headsFor(coreWorkspaceId, "retained")).toEqual([]);
    // The head is gone. The version stays, because admitted runs cite it.
    expect(await bindingsOf(coreWorkspaceId, "retained")).toEqual([
      { publicId: retained.bindingPublicId, version: 1 },
    ]);
    await dropMainHead();

    const rebound = await bind(coreWorkspaceId, "retained");
    expect(rebound.bindingId).toBe(retained.bindingPublicId);
    expect(await bindingsOf(coreWorkspaceId, "retained")).toEqual([
      { publicId: retained.bindingPublicId, version: 1 },
    ]);
    expect(await headsFor(coreWorkspaceId, "retained")).toEqual([
      { role: "steering", providerRepositoryId: repoId("acme", "retained") },
    ]);
  });
});
