// agent.definition.commit.ts — write an agent's definition of record to the
// workspace repository and open the pull request that publishes it (MC spec
// §6.2, §10.2; ADR-057 decision 1; #2956).
//
// Flow:
//   1. Role gate — org Owner, Admin or Member (assertOrgRole, INV-29), for
//      the signed-in user or the creator of the API key (resolveActingUserId).
//      That user is the committer the delegation ceiling reads.
//   2. The agent, in this workspace; a retired agent accepts no definition.
//   3. The file: `schema` must be the canonical schema and `slug` the
//      agent's; the `tools` it names are checked against the committer's own
//      grants for an enterprise organization (the delegation ceiling of
//      spec §6.2: a person can grant an agent no more than they hold).
//   4. The repository: the binding named by `repositoryId`, or the
//      workspace's one binding; a branch equal to the binding's configured
//      default ref or the repository's default branch is refused, so the
//      default branch is never written.
//   5. GitHub: the branch is created from the default branch when it does
//      not exist, the file is put on it, and the branch's open pull request
//      against the default branch is reused or, when there is none, opened.
//      GitHub refuses a second pull request for a head that has one open
//      (422), so the lookup runs before the file is written: a Save to a
//      branch already under review must not leave the commit in git with no
//      version row behind it. Nothing here merges.
//   6. A new unpublished `agent_versions` row caches the path, digest,
//      source, commit, branch and pull request. The config column carries
//      the latest version's config forward so the legacy definition reads
//      keep parsing. The version number is read in the transaction that
//      inserts it, and a unique violation on (agent, version) is retried
//      there: two saves on one agent in the same instant both get a row,
//      and no commit is left in git without one.
import {
  isUniqueViolation,
  schema,
  withTenantDb,
  type Tx,
} from "@oxagen/database";
import { resolveAgentIdentity } from "@oxagen/agent/handlers/_agent-identity";
import { canAccessACL, resolveOrgTier } from "@oxagen/billing";
import { createGitHubClient, OXAGEN_PR_LABELS } from "@oxagen/github";
import { fetchAgentRunAuthz } from "@oxagen/iam";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { getCapability, HandlerError } from "@oxagen/oxagen";
import { parseAgentDefinitionSource } from "@oxagen/oxagen/agent-definition-source";
import {
  AGENT_DEFINITION_DIR,
  AGENT_DEFINITION_SCHEMA,
  agentDefinitionCommit,
} from "@oxagen/oxagen/contracts/agent.definition.commit";
import { resolve as resolveIam } from "@oxagen/oxagen/iam";
import { and, desc, eq, inArray } from "drizzle-orm";
import { assertNotRetired } from "./lib/agent-identity";
import { resolveGitHubToken } from "./lib/github-token";
import { logger } from "./logger";
import { sha256Hex } from "./registry-digest";

const AGENT_DEFINITION_ROLES = ["Owner", "Admin", "Member"] as const;

/**
 * The top-level `key = "value"` string of a TOML subset (spec §6.2's file
 * shape), or null. Retained for callers that inspect legacy source snippets;
 * definition writes use the full TOML parser below.
 */
export function readTopLevelString(source: string, key: string): string | null {
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = new RegExp(
      `^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*(#.*)?$`,
    ).exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** The strings of a top-level `key = [ "a", "b" ]` array, across lines, or []. */
export function readTopLevelStringArray(source: string, key: string): string[] {
  const head = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m").exec(source);
  if (!head) return [];
  // Stop at the first top-level table header, so a `tools` key inside
  // `[harness.x]` is not read as the definition's belt.
  const prefix = source.slice(0, head.index);
  if (/^\s*\[/m.test(prefix)) return [];
  const rest = source.slice(head.index + head[0].length);
  const close = rest.indexOf("]");
  if (close < 0) return [];
  const body = rest.slice(0, close);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

export function definitionPathFor(slug: string): string {
  return `${AGENT_DEFINITION_DIR}/${slug}.toml`;
}

/** The capability names a `tools` list names outright: registered contracts, never globs or MCP tools. */
export function capabilityToolsOf(tools: readonly string[]): string[] {
  return tools.filter(
    (t) =>
      !t.includes("*") && !t.includes("__") && getCapability(t) !== undefined,
  );
}

interface RepositoryTarget {
  bindingPublicId: string;
  owner: string;
  repo: string;
  configuredDefaultRef: string;
}

async function resolveRepository(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  repositoryId: string | undefined,
): Promise<RepositoryTarget> {
  const heads = await tx
    .select({
      currentBindingId: schema.repositoryBindingHeads.currentBindingId,
    })
    .from(schema.repositoryBindingHeads)
    .where(
      and(
        eq(schema.repositoryBindingHeads.orgId, scope.orgId),
        eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
        // Only the MAIN repository steers. `role` is 'main' for every head
        // the binder writes, and 'linked' only for one the exclusivity
        // migration demoted because an older head already claimed the
        // repository. A reader that ignores the column goes on resolving
        // through a demoted head, so the cross-workspace steering collision
        // the index forbids would survive the reconciliation that was meant
        // to end it.
        eq(schema.repositoryBindingHeads.role, "main"),
      ),
    );
  if (heads.length === 0) {
    throw new HandlerError({
      code: "conflict",
      reason: "no_repository",
      message: "This workspace binds no repository to commit the definition to",
    });
  }
  const bindings = await tx
    .select({
      publicId: schema.repositoryBindings.publicId,
      owner: schema.repositoryBindings.providerOwner,
      name: schema.repositoryBindings.providerName,
      configuredDefaultRef: schema.repositoryBindings.configuredDefaultRef,
    })
    .from(schema.repositoryBindings)
    .where(
      inArray(
        schema.repositoryBindings.id,
        heads.map((h) => h.currentBindingId),
      ),
    );
  const chosen =
    repositoryId === undefined
      ? bindings.length === 1
        ? bindings[0]
        : undefined
      : bindings.find((b) => b.publicId === repositoryId);
  if (!chosen) {
    throw new HandlerError({
      code: repositoryId === undefined ? "conflict" : "not_found",
      reason:
        repositoryId === undefined
          ? "repository_ambiguous"
          : "repository_not_found",
      message:
        repositoryId === undefined
          ? "This workspace binds more than one repository; name one with repositoryId"
          : `No repository binding "${repositoryId}" in this workspace`,
    });
  }
  return {
    bindingPublicId: chosen.publicId,
    owner: chosen.owner,
    repo: chosen.name,
    configuredDefaultRef: chosen.configuredDefaultRef,
  };
}

/**
 * The delegation ceiling on the definition's tools: every capability the
 * file names resolves to allow or approval for the committer's own human
 * principal. Below enterprise the kernel's IAM allows every capability to
 * every member (packages/iam/src/check-iam.ts), so the check is skipped
 * exactly where `assign_agent_role` skips it.
 */
async function assertToolsWithinCeiling(
  tx: Tx,
  ctx: { orgId: string; workspaceId: string; userId: string },
  tools: readonly string[],
  now: Date,
): Promise<void> {
  const exceeded = await toolsBeyondCeiling(tx, ctx, tools, now);
  if (exceeded === "no_principal") {
    throw new HandlerError({
      code: "forbidden",
      reason: "delegation_ceiling",
      message: "The committer has no active principal to grant from",
    });
  }
  if (exceeded.length > 0) {
    throw new HandlerError({
      code: "forbidden",
      reason: "delegation_ceiling",
      message: `The definition names tools you do not hold: ${exceeded.join(", ")}`,
    });
  }
}

/**
 * The capabilities in `tools` the user's own human principal is denied, or
 * `no_principal` when the user holds no active principal in the org to
 * grant from. `propose_agent` reads the list to fail its authority check;
 * `commit_agent_definition` refuses on it.
 */
export async function toolsBeyondCeiling(
  tx: Tx,
  ctx: { orgId: string; workspaceId: string; userId: string },
  tools: readonly string[],
  now: Date,
): Promise<string[] | "no_principal"> {
  if (tools.length === 0) return [];
  const [human] = await tx
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, ctx.orgId),
        eq(schema.principals.parentUserId, ctx.userId),
        eq(schema.principals.kind, "human"),
        eq(schema.principals.status, "active"),
      ),
    )
    .limit(1);
  if (!human) return "no_principal";
  const snapshot = await fetchAgentRunAuthz({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    agentPrincipalId: human.id,
    humanPrincipalId: null,
    now,
  });
  return tools.filter(
    (capability) =>
      resolveIam({
        principal: {
          id: human.id,
          kind: "human",
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        capability,
        scope: {
          kind: "workspace",
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        grants: snapshot.grants,
        roles: snapshot.roles,
        roleGrants: snapshot.roleGrants,
        policies: snapshot.policies,
        defaultEffect: getCapability(capability)?.defaultEffect ?? "deny",
        now,
      }).outcome === "deny",
  );
}

/** Tries after the first unique violation on (agent, version); each try re-reads the latest row. */
const VERSION_INSERT_RETRIES = 2;

/**
 * Insert the version row that caches the commit. The latest version and its
 * config are read in the inserting transaction; a concurrent save that takes
 * the same number surfaces as a unique violation and the insert is tried
 * again on the number it then reads.
 */
async function insertVersionRow(
  row: {
    agentId: string;
    userId: string;
    path: string;
    digest: string;
    source: string;
    commitSha: string;
    branch: string;
    pullRequestUrl: string;
  },
  retriesLeft = VERSION_INSERT_RETRIES,
): Promise<number> {
  try {
    return await withTenantDb(async (tx) => {
      const [latest] = await tx
        .select({
          version: schema.agentVersions.version,
          config: schema.agentVersions.config,
        })
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.agentId, row.agentId))
        .orderBy(desc(schema.agentVersions.version))
        .limit(1);
      const [inserted] = await tx
        .insert(schema.agentVersions)
        .values({
          agentId: row.agentId,
          version: (latest?.version ?? 0) + 1,
          isPublished: false,
          checksum: null,
          config: latest?.config ?? {},
          createdById: row.userId,
          definitionPath: row.path,
          definitionDigest: row.digest,
          definitionSource: row.source,
          commitSha: row.commitSha,
          branch: row.branch,
          pullRequestUrl: row.pullRequestUrl,
        })
        .returning({ version: schema.agentVersions.version });
      if (!inserted) throw new Error("agent_versions insert returned no row");
      return inserted.version;
    });
  } catch (err) {
    if (
      retriesLeft > 0 &&
      isUniqueViolation(err, "agent_versions_agent_version_uniq")
    ) {
      return insertVersionRow(row, retriesLeft - 1);
    }
    throw err;
  }
}

export const agentDefinitionCommitHandler: CapabilityHandler<
  typeof agentDefinitionCommit
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: [...AGENT_DEFINITION_ROLES] },
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const now = new Date();
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

  const definition = parseAgentDefinitionSource(input.source);
  const fileSchema = definition["schema"];
  if (fileSchema !== AGENT_DEFINITION_SCHEMA) {
    throw new HandlerError({
      code: "conflict",
      reason: "definition_schema",
      message: `The definition must declare schema = "${AGENT_DEFINITION_SCHEMA}"`,
    });
  }

  const prepared = await withTenantDb(async (tx) => {
    const agent = await resolveAgentIdentity(tx, input.agentId, scope);
    if (!agent) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `No agent "${input.agentId}" in this workspace`,
      });
    }
    assertNotRetired(agent);
    const fileSlug = definition["slug"];
    if (fileSlug !== agent.slug) {
      throw new HandlerError({
        code: "conflict",
        reason: "definition_slug",
        message: `The definition's slug must be "${agent.slug}"`,
      });
    }
    const tier = ctx.planTier ?? (await resolveOrgTier(ctx.orgId));
    if (canAccessACL(tier)) {
      await assertToolsWithinCeiling(
        tx,
        { ...scope, userId },
        capabilityToolsOf((definition["tools"] ?? []) as string[]),
        now,
      );
    }
    const repository = await resolveRepository(tx, scope, input.repositoryId);
    if (input.branch === repository.configuredDefaultRef) {
      throw new HandlerError({
        code: "conflict",
        reason: "branch_is_default",
        message: `"${input.branch}" is the repository's production branch; commit to another branch`,
      });
    }
    return { agent, repository };
  });

  const { agent, repository } = prepared;
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });
  const info = await gh.getRepoInfo({
    owner: repository.owner,
    repo: repository.repo,
  });
  if (input.branch === info.defaultBranch) {
    throw new HandlerError({
      code: "conflict",
      reason: "branch_is_default",
      message: `"${input.branch}" is the repository's default branch; commit to another branch`,
    });
  }
  const branches = await gh.listBranches({
    owner: repository.owner,
    repo: repository.repo,
  });
  if (!branches.some((b) => b.name === input.branch)) {
    await gh.createBranch({
      owner: repository.owner,
      repo: repository.repo,
      branch: input.branch,
      fromBranch: info.defaultBranch,
    });
  }
  const [existingPr] = await gh.listPullRequests({
    owner: repository.owner,
    repo: repository.repo,
    head: `${repository.owner}:${input.branch}`,
    state: "open",
  });
  const path = definitionPathFor(agent.slug);
  const digest = sha256Hex(input.source);
  const message = input.message ?? `Agent definition: ${agent.slug}`;
  const commit = await gh.putFile({
    owner: repository.owner,
    repo: repository.repo,
    path,
    content: input.source,
    message,
    branch: input.branch,
  });
  const pr =
    existingPr ??
    (await gh.openPullRequest({
      owner: repository.owner,
      repo: repository.repo,
      title: message,
      head: input.branch,
      base: info.defaultBranch,
      labels: OXAGEN_PR_LABELS,
      body: `Definition of record for agent \`${agent.slug}\` (\`${path}\`, sha256 \`${digest}\`). Merging publishes it.`,
    }));

  const version = await insertVersionRow({
    agentId: agent.id,
    userId,
    path,
    digest,
    source: input.source,
    commitSha: commit.commitSha,
    branch: input.branch,
    pullRequestUrl: pr.htmlUrl,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      agentId: agent.publicId,
      repository: `${repository.owner}/${repository.repo}`,
      branch: input.branch,
      pullRequest: pr.number,
    },
    existingPr
      ? "agent.definition.commit: definition committed to the branch's open pull request"
      : "agent.definition.commit: definition committed and pull request opened",
  );

  return {
    agentId: agent.publicId,
    version,
    path,
    digest,
    commitSha: commit.commitSha,
    branch: input.branch,
    pullRequest: { number: pr.number, url: pr.htmlUrl },
  };
};
