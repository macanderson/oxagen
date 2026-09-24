// repository.binding-write.ts — the one writer of a NEW binding head, shared
// by `create_workspace` (the main head, written with the workspace) and
// `link_repository` (a linked head).
//
// `bind_main_repository` keeps its own writer because it also repairs and
// re-approves an EXISTING head in place; this one only ever adds a head.
//
// A binding is immutable and versioned (`ingestion.repository_bindings`), and
// `repository_bindings_repository_version_uq` is on (connection, repository,
// version). A repository this connection bound before — linked, unlinked, and
// now linked again — therefore already HAS a version 1, and writing another
// would violate that index. So the latest version for the pair is read first:
// reused when nothing it records has moved, superseded by version + 1 when
// something has, and only when there is none is a version 1 written.
import { schema, type Tx } from "@oxagen/database";

import { and, desc, eq } from "drizzle-orm";
import { GITHUB_PROVIDER } from "./repository.github-connection";

export type RepositoryHeadRole = "main" | "linked";

/** The hosts a binding can name (`repository_bindings_provider_check`). */
export type RepositoryProvider = "github" | "gitlab";

/**
 * The repository facts a binding records, whichever host reported them. A
 * GitHub `GitHubRepoInfo` satisfies it; on GitLab `owner` is the full
 * namespace path and `id` the numeric project id.
 */
export interface BindableRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface NewRepositoryHead {
  scope: { orgId: string; workspaceId: string };
  /** The `source_connections` row the head and binding hang off. */
  connectionId: string;
  repo: BindableRepository;
  role: RepositoryHeadRole;
  /**
   * The host. Defaults to GitHub, the only host `create_workspace` and
   * `link_repository` bind today. `provider_repository_id` is unique only
   * within one host, so the retained-version lookup filters on it too.
   */
  provider?: RepositoryProvider;
  userId: string;
  now: Date;
}

export interface WrittenRepositoryHead {
  /** `rpb_…` of the binding version the new head points at. */
  bindingPublicId: string;
}

/**
 * Write a binding head for `repo` on `tx`, reusing or superseding a binding
 * version this connection already holds for it. The caller has already decided
 * the head may exist (role, duplicates, claims) and holds the workspace lock.
 */
export async function writeRepositoryHead(
  tx: Tx,
  args: NewRepositoryHead,
): Promise<WrittenRepositoryHead> {
  const { scope, connectionId, repo, role, userId, now } = args;
  const provider = args.provider ?? GITHUB_PROVIDER;

  const [latest] = await tx
    .select({
      id: schema.repositoryBindings.id,
      publicId: schema.repositoryBindings.publicId,
      version: schema.repositoryBindings.version,
      providerOwner: schema.repositoryBindings.providerOwner,
      providerName: schema.repositoryBindings.providerName,
      providerFullName: schema.repositoryBindings.providerFullName,
      configuredDefaultRef: schema.repositoryBindings.configuredDefaultRef,
    })
    .from(schema.repositoryBindings)
    .where(
      and(
        eq(schema.repositoryBindings.orgId, scope.orgId),
        eq(schema.repositoryBindings.workspaceId, scope.workspaceId),
        eq(schema.repositoryBindings.connectionId, connectionId),
        eq(schema.repositoryBindings.provider, provider),
        eq(schema.repositoryBindings.providerRepositoryId, repo.id),
      ),
    )
    .orderBy(desc(schema.repositoryBindings.version))
    .limit(1);

  let binding: { id: string; publicId: string };
  const unchanged =
    latest !== undefined &&
    latest.providerOwner === repo.owner &&
    latest.providerName === repo.name &&
    latest.providerFullName === repo.fullName &&
    latest.configuredDefaultRef === repo.defaultBranch;
  if (latest !== undefined && unchanged) {
    binding = { id: latest.id, publicId: latest.publicId };
  } else {
    const [inserted] = await tx
      .insert(schema.repositoryBindings)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        connectionId,
        provider,
        providerRepositoryId: repo.id,
        providerOwner: repo.owner,
        providerName: repo.name,
        providerFullName: repo.fullName,
        configuredDefaultRef: repo.defaultBranch,
        observedAt: now,
        version: latest === undefined ? 1 : latest.version + 1,
        supersedesBindingId: latest === undefined ? null : latest.id,
        createdAt: now,
        createdById: userId,
      })
      .returning({
        id: schema.repositoryBindings.id,
        publicId: schema.repositoryBindings.publicId,
      });
    if (!inserted)
      throw new Error("repository_bindings insert returned no row");
    binding = inserted;
  }

  await tx.insert(schema.repositoryBindingHeads).values({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    connectionId,
    provider,
    providerRepositoryId: repo.id,
    currentBindingId: binding.id,
    // Written out rather than left to the column default: which role a head
    // carries is the whole question `repository_binding_heads_main_repository_uq`
    // answers.
    role,
    createdAt: now,
    updatedAt: now,
  });

  return { bindingPublicId: binding.publicId };
}
