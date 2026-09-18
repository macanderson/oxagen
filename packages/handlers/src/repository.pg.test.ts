// The §10.1 repository model against a real Postgres (Mission Control spec
// §17 M0; ADR-099): a workspace is created with its main repository and gets
// exactly one `role = 'main'` head; a second repository is linked and the
// workspace has two heads; the linked one is unlinked and its binding version
// survives; the main one cannot be unlinked; another workspace's main
// repository cannot be linked; a repository that is nobody's main links to two
// workspaces; and every reader that resolves "the main repository" keeps
// answering it while a linked head sits beside it. Then the other direction
// (review of #3326): a repository linked anywhere cannot become a main
// repository, a workspace with GitHub attached but no main head cannot link,
// and the store's trigger refuses, by constraint name, the three writes the
// handlers' pre-checks refuse by sentence. Runs wherever DATABASE_URL
// points at a migrated database — CI's `test` job migrates Postgres with Atlas
// before `turbo run build test:unit`; a local run without one is skipped, not
// red. Every row it writes is removed in afterAll.
//
// The fixture mirrors organization.pg.test.ts: an enterprise org, an Admin
// with a principal and the seeded Admin role, and a first workspace the
// create calls are scoped to. GitHub is answered by fixtures — one
// installation on `acme` and a repository whose id is a pure function of
// owner/name, so two reads of one repository agree, and two workspaces asking
// for the same repository collide the way two real ones would.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { readGitHubConnection } from "./context.steering.github";
import { GITHUB_PROVIDER } from "./repository.github-connection";
import { createRepositoryLinkHandler } from "./repository.link";
import { repositoryListHandler } from "./repository.list";
import {
  createMainRepositoryBindHandler,
  repositoryHeadConflict,
} from "./repository.main.bind";
import { createMainRepositoryGetHandler } from "./repository.main.get";
import { repositoryUnlinkHandler } from "./repository.unlink";
import { createWorkspaceCreateHandler } from "./workspace.create";

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
  const createWorkspace = createWorkspaceCreateHandler(github);
  const linkRepository = createRepositoryLinkHandler(github);
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

  const create = (slug: string, repo: string) =>
    inWorkspace(coreWorkspaceId, () =>
      createWorkspace(
        workspaceCreate.input.parse({
          name: slug,
          slug,
          mainRepo: { owner: "acme", name: repo },
        }),
        ctx(coreWorkspaceId),
      ),
    );
  const link = (workspaceId: string, repo: string) =>
    inWorkspace(workspaceId, () =>
      linkRepository(
        repositoryLink.input.parse({ owner: "acme", name: repo }),
        ctx(workspaceId),
      ),
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
      repositoryUnlinkHandler(
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
      // The heads and bindings the creates and links wrote, main and linked.
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

  it("walks the model: create with a main repo, link a second, the readers keep answering main, unlink the linked one, refuse to unlink main, refuse another workspace's main, share a repository that is nobody's main", async () => {
    // ── create: exactly one head, role main ──────────────────────────────
    const alpha = await create("alpha", "alpha");
    expect(alpha.mainRepo.fullName).toBe("acme/alpha");
    const alphaId = await internalId(alpha.publicId);
    expect(await headsOf(alphaId)).toEqual([
      { role: "main", providerRepositoryId: repoId("acme", "alpha") },
    ]);

    const beta = await create("beta", "beta");
    const betaId = await internalId(beta.publicId);
    expect(await headsOf(betaId)).toEqual([
      { role: "main", providerRepositoryId: repoId("acme", "beta") },
    ]);

    // A third workspace asking for alpha's main repository is refused by the
    // global claim, and no workspace row is left behind.
    await expect(refusal(create("gamma", "alpha"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_claimed",
    });
    expect(
      await withSystemDb((tx) =>
        tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.orgId, orgId),
              eq(schema.workspaces.slug, "gamma"),
            ),
          ),
      ),
    ).toEqual([]);

    // ── link a second repo: two heads, main + linked ─────────────────────
    const shared = await link(alphaId, "shared");
    expect(shared).toMatchObject({
      fullName: "acme/shared",
      role: "linked",
      connectionId: alpha.mainRepo.connectionId,
    });
    expect(await headsOf(alphaId)).toEqual([
      { role: "linked", providerRepositoryId: repoId("acme", "shared") },
      { role: "main", providerRepositoryId: repoId("acme", "alpha") },
    ]);
    const listed = await list(alphaId);
    expect(
      listed.repositories.map((r) => [r.role, r.fullName, r.connectionLive]),
    ).toEqual([
      ["main", "acme/alpha", true],
      ["linked", "acme/shared", true],
    ]);
    expect(listed.repositories[0]?.bindingId).toBe(alpha.mainRepo.bindingId);
    expect(listed.repositories[1]?.bindingId).toBe(shared.bindingId);

    // ── the readers that resolve THE main repository filter role = 'main' ──
    // With a linked head beside the main one, a reader that ignored the
    // column could answer either; both keep answering alpha.
    const main = await inWorkspace(alphaId, () =>
      getMainRepository({}, ctx(alphaId)),
    );
    expect(main.repository).toMatchObject({
      bindingId: alpha.mainRepo.bindingId,
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
    await expect(refusal(link(alphaId, "beta"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_claimed",
    });
    // This workspace's own main is a different refusal, and an existing link
    // a third.
    await expect(refusal(link(alphaId, "alpha"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo",
    });
    await expect(refusal(link(alphaId, "shared"))).resolves.toEqual({
      code: "conflict",
      reason: "repository_already_linked",
    });

    // ── a repository that is main in neither links to both ───────────────
    const sharedInBeta = await link(betaId, "shared");
    expect(sharedInBeta.role).toBe("linked");
    expect(await headsOf(betaId)).toHaveLength(2);
    expect(await headsOf(alphaId)).toHaveLength(2);

    // ── unlink the linked one: main untouched, the binding version kept ──
    const unlinked = await unlink(alphaId, shared.bindingId);
    expect(unlinked).toMatchObject({
      bindingId: shared.bindingId,
      fullName: "acme/shared",
    });
    expect(await headsOf(alphaId)).toEqual([
      { role: "main", providerRepositoryId: repoId("acme", "alpha") },
    ]);
    expect(await bindingsOf(alphaId, "shared")).toEqual([
      { publicId: shared.bindingId, version: 1 },
    ]);
    // Beta's link to the same repository is its own head and is untouched.
    expect(await headsOf(betaId)).toHaveLength(2);

    // ── unlink main: refused, nothing moves ──────────────────────────────
    await expect(
      refusal(unlink(alphaId, alpha.mainRepo.bindingId)),
    ).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_unlink_refused",
    });
    expect(await headsOf(alphaId)).toHaveLength(1);
    // Nor can a head be unlinked twice, or from a workspace that never saw it.
    await expect(refusal(unlink(alphaId, shared.bindingId))).resolves.toEqual({
      code: "not_found",
      reason: "repository_not_linked",
    });
    await expect(
      refusal(unlink(betaId, alpha.mainRepo.bindingId)),
    ).resolves.toEqual({
      code: "not_found",
      reason: "repository_not_linked",
    });

    // ── re-link: the retained version is reused, no second version 1 ────
    const again = await link(alphaId, "shared");
    expect(again.bindingId).toBe(shared.bindingId);
    expect(await bindingsOf(alphaId, "shared")).toEqual([
      { publicId: shared.bindingId, version: 1 },
    ]);
    expect(await headsOf(alphaId)).toHaveLength(2);
  });

  it("holds the rule in the other direction and at the store: a linked repository cannot become a main, a link needs a main first, and the trigger refuses what the pre-checks refuse", async () => {
    // Left by the walk above: alpha (main alpha, linked shared) and beta
    // (main beta, linked shared). `shared` is main nowhere.
    const alphaId = await workspaceIdBySlug("alpha");
    const betaId = await workspaceIdBySlug("beta");

    // ── create with a repository that is linked elsewhere: refused, no row ──
    await expect(refusal(create("delta", "shared"))).resolves.toEqual({
      code: "conflict",
      reason: "repository_linked_elsewhere",
    });
    expect(
      await withSystemDb((tx) =>
        tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.orgId, orgId),
              eq(schema.workspaces.slug, "delta"),
            ),
          ),
      ),
    ).toEqual([]);

    // ── the first workspace: GitHub attached, no main head yet ────────────
    // What the install callback leaves behind on the organisation's first
    // workspace before `bind_main_repository` runs (ADR-099 §6).
    await withSystemDb((tx) =>
      tx.insert(schema.sourceConnections).values({
        orgId,
        workspaceId: coreWorkspaceId,
        connectorId: GITHUB_PROVIDER,
        displayName: "GitHub",
        authScheme: "oauth2_authorization_code",
        deliveryMethod: "webhook",
        deliveryConfig: { installationId: "555" },
        status: "pending_setup",
        createdById: userId,
      }),
    );
    expect(await headsOf(coreWorkspaceId)).toEqual([]);

    // A link before the main: refused, nothing written.
    await expect(refusal(link(coreWorkspaceId, "orphan"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_unbound",
    });
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
            .set({ role: "main" })
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
      { role: "main", providerRepositoryId: repoId("acme", "beta") },
    ]);
    expect(await headsOf(alphaId)).toHaveLength(2);

    // ── and what the rule allows still passes the trigger ────────────────
    // A repository nobody holds becomes the first workspace's main through
    // `bind_main_repository`, and `shared`, main nowhere, links to a third
    // workspace.
    const bound = await bind(coreWorkspaceId, "orphan");
    expect(bound.fullName).toBe("acme/orphan");
    const third = await link(coreWorkspaceId, "shared");
    expect(third.role).toBe("linked");
    expect(await headsOf(coreWorkspaceId)).toEqual([
      { role: "linked", providerRepositoryId: repoId("acme", "shared") },
      { role: "main", providerRepositoryId: repoId("acme", "orphan") },
    ]);
  });

  it("a workspace left with no main head binds its way out: a linked head is promoted in place, and a version retained from an unlinked head is reused", async () => {
    // The state the exclusivity migration's demotion leaves, and the only way
    // to reach it now that a link needs a main head first: the main head is
    // gone and a linked one is all the workspace has. Both writes below used to
    // insert a second version-1 binding for a pair that already had one, which
    // `repository_bindings_repository_version_uq` refuses — and that refusal
    // names no cross-workspace claim, so it reached the operator as a 500 on
    // the one move that would give the workspace a main repository back.
    const dropMainHead = () =>
      withSystemDb((tx) =>
        tx
          .delete(schema.repositoryBindingHeads)
          .where(
            and(
              eq(schema.repositoryBindingHeads.workspaceId, coreWorkspaceId),
              eq(schema.repositoryBindingHeads.role, "main"),
            ),
          ),
      );

    // ── a linked head, then no main head, then the bind ───────────────────
    const linked = await link(coreWorkspaceId, "promoted");
    expect(linked.role).toBe("linked");
    await dropMainHead();

    const promoted = await bind(coreWorkspaceId, "promoted");
    // The same binding version the link wrote: nothing it records has moved,
    // so only the role did.
    expect(promoted.bindingId).toBe(linked.bindingId);
    expect(await bindingsOf(coreWorkspaceId, "promoted")).toEqual([
      { publicId: linked.bindingId, version: 1 },
    ]);
    expect(
      (await headsOf(coreWorkspaceId)).filter(
        (h) => h.providerRepositoryId === repoId("acme", "promoted"),
      ),
    ).toEqual([
      { role: "main", providerRepositoryId: repoId("acme", "promoted") },
    ]);

    // ── a version retained from an unlinked head ──────────────────────────
    const retained = await link(coreWorkspaceId, "retained");
    await unlink(coreWorkspaceId, retained.bindingId);
    // The head is gone; the version stays, because admitted runs cite it.
    expect(await bindingsOf(coreWorkspaceId, "retained")).toEqual([
      { publicId: retained.bindingId, version: 1 },
    ]);
    await dropMainHead();

    const rebound = await bind(coreWorkspaceId, "retained");
    expect(rebound.bindingId).toBe(retained.bindingId);
    expect(await bindingsOf(coreWorkspaceId, "retained")).toEqual([
      { publicId: retained.bindingId, version: 1 },
    ]);
    expect(
      (await headsOf(coreWorkspaceId)).filter(
        (h) => h.providerRepositoryId === repoId("acme", "retained"),
      ),
    ).toEqual([
      { role: "main", providerRepositoryId: repoId("acme", "retained") },
    ]);
  });
});
