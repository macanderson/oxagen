// linked-repos.ts: the GitHub repositories linked to a workspace, which are
// the only repositories a work collector may read.
//
// A repository is linked when the workspace holds a binding head for it: the
// steering repository, or one a merged workspace.toml change linked. The head
// names the GitHub connection the repository was linked through, so a
// collector reads through that connection. set_work_collector refuses any
// other repository, and the collector store drops a repository from a
// collector's scope once it is unlinked, so a stale scope collects nothing.
import { schema, type Tx } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { WorkScope } from "../work-records/store";

const heads = schema.repositoryBindingHeads;
const bindings = schema.repositoryBindings;

/** One linked GitHub repository: its owner/name and the connection it was linked through. */
export interface LinkedRepository {
  fullName: string;
  connectionId: string;
}

/** The workspace's linked GitHub repositories, keyed by lowercased owner/name. */
export async function linkedGithubRepositories(tx: Tx, scope: WorkScope): Promise<Map<string, LinkedRepository>> {
  const rows = await tx
    .select({ fullName: bindings.providerFullName, connectionId: heads.connectionId })
    .from(heads)
    .innerJoin(bindings, eq(bindings.id, heads.currentBindingId))
    .where(and(eq(heads.orgId, scope.orgId), eq(heads.workspaceId, scope.workspaceId), eq(heads.provider, "github")));
  return new Map(rows.map((row) => [row.fullName.toLowerCase(), row]));
}

/** A collector scope with every repository the workspace no longer links dropped. */
export function linkedScope(
  scope: Record<string, unknown>,
  linked: ReadonlyMap<string, LinkedRepository>,
): Record<string, unknown> {
  if (!Array.isArray(scope.repos)) return scope;
  return {
    ...scope,
    repos: scope.repos.filter((repo) => typeof repo === "string" && linked.has(repo.toLowerCase())),
  };
}
