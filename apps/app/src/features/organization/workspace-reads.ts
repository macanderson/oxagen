"use server";
// The reads the Workspaces tab makes inside a workspace (pages/organization.md,
// Workspaces): what each workspace binds and how many agents it registers,
// and, when Create a workspace opens, the repositories a new workspace can
// take as its main one.
//
// `list_workspaces` is an organization read and records none of this. The
// facts live one scope down: `list_repositories` answers a workspace's main
// and linked repositories with the approved default ref, and `list_agents`
// counts its identities. Both are workspace-scoped, so each read resolves the
// workspace viewer first (`requireViewer(org, ws)`, where membership is
// checked, INV-15); the tab asks only for the workspaces its viewer may enter,
// and says "not recorded" for the rest.
//
// They are "use server" reads rather than DataSource ports because the tab
// makes one per workspace and the create dialog's is a live GitHub call made
// only when a person opens it (ARCHITECTURE.md §2, the on-demand read).
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import {
  type ActionResult,
  kernelRead,
  readToActionResult,
} from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** One repository a workspace binds, as the Workspaces row and Edit workspace print it. */
export type BoundRepository = {
  role: "main" | "linked";
  fullName: string;
  /** The approved production ref the binding records, never live GitHub's. */
  defaultRef: string;
};

/** What the Workspaces row draws for a workspace its viewer may enter. */
export type WorkspaceFacts = {
  /** Main first, then the linked ones by full name, as `list_repositories` orders them. */
  repositories: BoundRepository[];
  /** `list_agents` totals.identities: over the whole workspace, never a page. */
  agents: number;
};

/**
 * The bound repositories and the agent count of one workspace. Either read
 * refusing refuses the whole: a row that printed the repositories beside an
 * agent count it could not read would mix a fact with a gap in one cell set.
 */
export async function readWorkspaceFacts(
  org: string,
  ws: string,
): Promise<ActionResult<WorkspaceFacts>> {
  const ctx = await requireViewer(org, ws);
  const [repositories, agents] = await Promise.all([
    kernelRead(ctx, {
      contract: repositoryList,
      input: {},
      page: "organization",
    }),
    kernelRead(ctx, {
      contract: agentList,
      // One row is enough: the count is the totals block, over the workspace.
      input: { limit: 1 },
      page: "organization",
    }),
  ]);
  if (!repositories.ok) return readToActionResult(repositories);
  if (!agents.ok) return readToActionResult(agents);
  return {
    ok: true,
    value: {
      repositories: repositories.value.repositories.map((repo) => ({
        role: repo.role,
        fullName: repo.fullName,
        defaultRef: repo.defaultRef,
      })),
      agents: agents.value.totals.identities,
    },
  };
}

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
