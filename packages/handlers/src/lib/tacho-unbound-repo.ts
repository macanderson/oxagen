/**
 * `unbound_repo` on a Tacho host's policy bundle (#3941): what the host asks
 * when a session starts in a repository the organisation has not bound, and
 * the digests of every repository it has.
 *
 * The host decides at the first prompt, before the first model call, with no
 * round trip. It digests its `origin` remote (`canonicalRemote`, then
 * `foldedRemote`, in `@oxagen/tacho`) and looks for either digest in
 * `bound_remote_digests`. So this module digests each bound repository the
 * same way, from the name the binding recorded. The remote itself never
 * leaves the host (`collector/git-facts.ts`).
 *
 * The clause is sent only when both hold:
 *
 *  - the host advertised `BUNDLE_FEATURE_UNBOUND_REPO`. The host's bundle
 *    schema is strict, so a host built before the field would refuse the
 *    whole mandate over it.
 *  - the workspace's skills are on: the newest configuration version
 *    published under the workspace's current main repository says
 *    `enabled = true`. That is the version `get_skill_config` names as
 *    current.
 *
 * "Bound" is organisation-wide: a repository any workspace in the
 * organisation holds, as its main repository or a linked one. A repository
 * another workspace holds cannot be linked here or made the main repository
 * of a new workspace, so asking about it would offer two paths that both
 * fail.
 */
import {
  canonicalRemote,
  digestBytes,
  foldedRemote,
  policyBundleSchema,
  type PolicyBundle,
} from "@oxagen/tacho";
import { SKILL_INTERJECTION_TIMEOUT_MS } from "@oxagen/oxagen/skills";
import { schema, type Tx, withTransactionOrgWideRead } from "@oxagen/database";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { logger } from "../logger";

export type UnboundRepoClause = NonNullable<PolicyBundle["unbound_repo"]>;

/** The clause's schema as the host parses it. */
const unboundRepoClauseSchema = policyBundleSchema.shape.unbound_repo.unwrap();

/** The organisation and workspace the host is enrolled in. */
export interface UnboundRepoScope {
  orgId: string;
  workspaceId: string;
}

/** The head skills configuration of a workspace, as the clause needs it. */
export interface SkillsHead {
  /** The version label (`skl_v3`): the clause's `config_version`. */
  versionLabel: string;
  enabled: boolean;
  /** How many skill versions the configuration pins, across its sources. */
  pinned: number;
}

/** A repository some workspace in the organisation holds. */
export interface BoundRepository {
  provider: string;
  /** `owner/name`, or `group/subgroup/project` on GitLab. */
  fullName: string;
}

/** The reads the clause is built from; injectable so a test can answer them. */
export interface UnboundRepoReads {
  skillsHead(tx: Tx, scope: UnboundRepoScope): Promise<SkillsHead | undefined>;
  workspaceSlug(tx: Tx, scope: UnboundRepoScope): Promise<string | undefined>;
  linkedRepositories(tx: Tx, scope: UnboundRepoScope): Promise<number>;
  boundRepositories(
    tx: Tx,
    scope: UnboundRepoScope,
  ): Promise<BoundRepository[]>;
}

/** A connection that still stands: not deleted and not being deleted. */
function liveConnection() {
  const connections = schema.sourceConnections;
  return and(
    isNull(connections.deletedAt),
    notInArray(connections.status, ["deleting", "deleted"]),
  );
}

/**
 * The newest configuration version published under the workspace's current
 * main repository binding, or undefined when the workspace has no main
 * repository or has published none.
 */
async function readSkillsHead(
  tx: Tx,
  scope: UnboundRepoScope,
): Promise<SkillsHead | undefined> {
  const versions = schema.skillConfigVersions;
  const heads = schema.repositoryBindingHeads;
  const connections = schema.sourceConnections;
  const [row] = await tx
    .select({
      versionLabel: versions.versionLabel,
      enabled: versions.enabled,
      sources: versions.sources,
    })
    .from(versions)
    .innerJoin(
      heads,
      and(
        eq(heads.currentBindingId, versions.repositoryBindingId),
        eq(heads.orgId, scope.orgId),
        eq(heads.workspaceId, scope.workspaceId),
        eq(heads.role, "main"),
      ),
    )
    .innerJoin(connections, eq(connections.id, heads.connectionId))
    .where(
      and(
        eq(versions.orgId, scope.orgId),
        eq(versions.workspaceId, scope.workspaceId),
        liveConnection(),
      ),
    )
    .orderBy(desc(versions.publishedAt), desc(versions.createdAt))
    .limit(1);
  if (row === undefined) return undefined;
  return {
    versionLabel: row.versionLabel,
    enabled: row.enabled,
    pinned: row.sources.reduce(
      (sum, source) => sum + source.skills.length,
      0,
    ),
  };
}

async function readWorkspaceSlug(
  tx: Tx,
  scope: UnboundRepoScope,
): Promise<string | undefined> {
  const workspaces = schema.workspaces;
  const [row] = await tx
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, scope.workspaceId),
        eq(workspaces.orgId, scope.orgId),
      ),
    )
    .limit(1);
  return row?.slug;
}

/** How many repositories the workspace links besides its main one. */
async function readLinkedRepositories(
  tx: Tx,
  scope: UnboundRepoScope,
): Promise<number> {
  const heads = schema.repositoryBindingHeads;
  const connections = schema.sourceConnections;
  const [row] = await tx
    .select({ linked: sql<number>`count(*)::int` })
    .from(heads)
    .innerJoin(connections, eq(connections.id, heads.connectionId))
    .where(
      and(
        eq(heads.orgId, scope.orgId),
        eq(heads.workspaceId, scope.workspaceId),
        eq(heads.role, "linked"),
        liveConnection(),
      ),
    );
  return row?.linked ?? 0;
}

/**
 * Every repository a workspace in the organisation holds, main or linked,
 * by the name its current binding recorded. One statement, read on the
 * caller's connection with the organisation-wide read turned on
 * (`withTransactionOrgWideRead`). A second transaction here would hold two
 * pool connections per poll (see `resolveHostMandate`).
 */
async function readBoundRepositories(
  tx: Tx,
  scope: UnboundRepoScope,
): Promise<BoundRepository[]> {
  const heads = schema.repositoryBindingHeads;
  const bindings = schema.repositoryBindings;
  const connections = schema.sourceConnections;
  return withTransactionOrgWideRead(tx, async (orgTx) =>
    orgTx
      .select({
        provider: bindings.provider,
        fullName: bindings.providerFullName,
      })
      .from(heads)
      .innerJoin(bindings, eq(bindings.id, heads.currentBindingId))
      .innerJoin(connections, eq(connections.id, heads.connectionId))
      .where(
        and(
          eq(heads.orgId, scope.orgId),
          eq(bindings.orgId, scope.orgId),
          liveConnection(),
        ),
      ),
  );
}

export const POSTGRES_UNBOUND_REPO_READS: UnboundRepoReads = {
  skillsHead: readSkillsHead,
  workspaceSlug: readWorkspaceSlug,
  linkedRepositories: readLinkedRepositories,
  boundRepositories: readBoundRepositories,
};

/** The forge host a binding's provider names. GitLab is gitlab.com only. */
function forgeHost(provider: string): string {
  return provider === "gitlab" ? "gitlab.com" : "github.com";
}

/**
 * The digests of the bound repositories, as the host computes them from a
 * remote: `canonicalRemote` of `host/owner/name`, and the folded form of
 * that, which lowercases the path on a forge that ignores its case. Sorted
 * and without repeats, so the bundle's etag does not move when the read
 * returns the same rows in another order.
 */
export function boundRemoteDigests(
  repositories: readonly BoundRepository[],
): string[] {
  const digests = new Set<string>();
  for (const repository of repositories) {
    const canonical = canonicalRemote(
      `${forgeHost(repository.provider)}/${repository.fullName}`,
    );
    digests.add(digestBytes(canonical));
    digests.add(digestBytes(foldedRemote(canonical)));
  }
  return [...digests].sort();
}

/**
 * The `unbound_repo` clause for this host, or undefined when the bundle
 * carries none: the host did not advertise the field, the workspace's skills
 * are off, or the clause would not pass the host's own schema. A clause the
 * host cannot parse would make it refuse the whole mandate, so it is dropped
 * and logged instead.
 */
export async function resolveUnboundRepo(
  tx: Tx,
  scope: UnboundRepoScope,
  advertised: boolean,
  reads: UnboundRepoReads = POSTGRES_UNBOUND_REPO_READS,
): Promise<UnboundRepoClause | undefined> {
  if (!advertised) return undefined;
  const head = await reads.skillsHead(tx, scope);
  if (head === undefined || !head.enabled) return undefined;
  // One after another: they share the caller's connection.
  const slug = await reads.workspaceSlug(tx, scope);
  if (slug === undefined) return undefined;
  const linked = await reads.linkedRepositories(tx, scope);
  const bound = await reads.boundRepositories(tx, scope);
  const clause = unboundRepoClauseSchema.safeParse({
    policy: "ask",
    timeout_ms: SKILL_INTERJECTION_TIMEOUT_MS,
    workspace_slug: slug,
    config_version: head.versionLabel,
    bound_remote_digests: boundRemoteDigests(bound),
    link: { skills_pinned: head.pinned, linked_repositories: linked },
  });
  if (!clause.success) {
    logger.warn(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        repositories: bound.length,
        issue: clause.error.issues[0]?.path.join("."),
      },
      "unbound_repo left off the bundle: the clause would fail the host's schema, and the host would refuse the whole mandate",
    );
    return undefined;
  }
  return clause.data;
}
