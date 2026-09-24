"use server";
// The on-demand read the Workspaces tab makes (pages/organization.md,
// Workspaces): when Create a workspace opens, the repositories a new
// workspace can take as its main one.
//
// It is a "use server" read rather than a DataSource port because it is a
// live GitHub call made only when a person opens the dialog (ARCHITECTURE.md
// §2, the on-demand read). What each workspace binds and registers, which the
// tab draws on every render, is the `org.workspaceFacts` port instead.
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** A repository a new workspace can name as its main one, with the branch it would record. */
export type RepositoryChoice = {
  /** `owner/name`, what `create_workspace` takes. */
  fullName: string;
  /** GitHub's default branch: the production branch `create_workspace` records. */
  defaultBranch: string;
};

/**
 * The repositories the GitHub App installations behind these workspaces can
 * reach, by full name, for the Create a workspace dialog's Main repository
 * select. `create_workspace` resolves the installation from the repository's
 * owner through the organization's GitHub authorization, so an installation a
 * workspace of this organization already uses is one it can reach.
 *
 * A workspace whose installation cannot be read contributes nothing. When
 * none can be read the answer is the first refusal, and the dialog falls back
 * to a typed `owner/name`.
 */
export async function readRepositoryChoices(
  org: string,
  workspaces: readonly string[],
): Promise<ActionResult<RepositoryChoice[]>> {
  const reads = await Promise.all(
    workspaces.map(async (ws) => {
      const ctx = await requireViewer(org, ws);
      return kernelRead(ctx, {
        contract: repositoryInstallationList,
        input: {},
        page: "repositories",
      });
    }),
  );
  const byName = new Map<string, RepositoryChoice>();
  let refused: ActionResult<never> | null = null;
  for (const read of reads) {
    if (!read.ok) {
      const result = readToActionResult(read);
      if (refused === null && !result.ok) refused = result;
      continue;
    }
    for (const repo of read.value.repositories) {
      if (!byName.has(repo.fullName)) {
        byName.set(repo.fullName, {
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
        });
      }
    }
  }
  if (byName.size === 0 && refused !== null) return refused;
  return {
    ok: true,
    value: [...byName.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    ),
  };
}
