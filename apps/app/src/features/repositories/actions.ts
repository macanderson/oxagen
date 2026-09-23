"use server";
// What the Repositories page reads and writes (MC spec §10.1, §10.2, §11.4):
// the workspace's main repository, the repositories its GitHub App
// installation reaches, the bind that turns the second into the first
// (#2967), the list, link and unlink of every bound repository (§17 M0: "a
// second repo can be linked and unlinked"), what each one holds under
// `.oxagen/`, its production branch, the pull request that adds Oxagen to
// it, and the Context PRs Oxagen has open.
//
// These are reads made on demand rather than through a DataSource port. Most
// of them are live calls to GitHub through the workspace's installation
// (`list_installation_repositories`, `get_repository_tree`), made per
// repository once the page knows which repositories there are, and re-made
// after every write on the page. So the page asks for each record when it
// needs it, through this module, which resolves its own viewer exactly as a
// write does (§3.3, and the `features` row of §2).
//
// `bind_main_repository` also has an action in features/onboarding: the
// provisional banner binds the one repository the enrolling host reported.
// This one binds the repository a person picked out of the installation. Each
// feature owns its own actions (§2 admits no edge between two features), and
// the two callers refuse differently (the banner stays where it is, the page
// re-reads its panel), so the duplication is the seam, not an accident.
import { repositoryInstallationAttach } from "@oxagen/oxagen/contracts/repository.installation.attach";
import { repositoryInstallationCandidates } from "@oxagen/oxagen/contracts/repository.installation.candidates";
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { repositoryProductionBranchSet } from "@oxagen/oxagen/contracts/repository.production_branch.set";
import { repositoryInitPrOpen } from "@oxagen/oxagen/contracts/repository.init_pr.open";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import type { ContextPr } from "@/data/contracts/steering";
import type {
  AttachedInstallation,
  GitHubInstallations,
  InitPullRequest,
  InstallationRepositories,
  LinkedRepository,
  ProductionBranchSet,
  RepositoryChange,
  RepositoryChanges,
  RepositoryTree,
  UnlinkedRepository,
  WorkspaceRepositories,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type BoundRepository = {
  fullName: string;
  defaultRef: string;
  boundAt: string;
};

/**
 * The workspace's main repository, whether an installation is attached, and
 * the doors to GitHub. Answering all three at once is the point: they are
 * three faces of "can this workspace keep its steering in git yet, and if not,
 * what is the next click".
 */
export async function readWorkspaceRepository(
  org: string,
  ws: string,
): Promise<ActionResult<WorkspaceRepository>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: repositoryMainGet,
    input: {},
    page: "repositories",
  });
  return readToActionResult(read);
}

/**
 * The repositories the installation reaches — the set `bind_main_repository`
 * accepts, so nothing offered on screen can refuse on submit. Called only once
 * `readWorkspaceRepository` has said an installation is attached: without one
 * this is `conflict: github_not_connected`, which is a state the dialog
 * already knows how to show.
 */
export async function listInstallationRepositories(
  org: string,
  ws: string,
): Promise<ActionResult<InstallationRepositories>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: repositoryInstallationList,
    input: {},
    page: "repositories",
  });
  return readToActionResult(read);
}

/**
 * Bind the picked repository as this workspace's main repo. The installation
 * comes from the workspace's GitHub connection, never from the caller, so this
 * names only the repository; a repository the installation cannot read is
 * `not_found: repository_not_installed`, and a workspace that already binds a
 * different one is `conflict: main_repo_bound`.
 */
export async function bindWorkspaceRepository(
  org: string,
  ws: string,
  repository: { owner: string; name: string },
): Promise<ActionResult<BoundRepository>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, repositoryMainBind, {
    owner: repository.owner,
    name: repository.name,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          fullName: result.value.fullName,
          defaultRef: result.value.defaultRef,
          boundAt: result.value.boundAt,
        },
      }
    : result;
}

/**
 * The GitHub App installations this workspace could act through.
 *
 * Called in the one state that uses it: GitHub is authorized for the org but no
 * installation is attached to this workspace. That state is reachable and
 * ordinary — the dialog's Connect action opens GitHub's identity URL, which
 * always returns a code and never an `installation_id` — so the panel asks
 * rather than assuming the person has nothing to pick from. A live GitHub call,
 * like the repository listing, and made for the same reason: the set on screen
 * has to be the set the write accepts.
 */
export async function listGithubInstallations(
  org: string,
  ws: string,
): Promise<ActionResult<GitHubInstallations>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: repositoryInstallationCandidates,
    input: {},
    page: "repositories",
  });
  return readToActionResult(read);
}

/**
 * Make one of those installations the one this workspace acts through.
 *
 * The id is named by the caller and checked by the handler against the
 * workspace's own `/user/installations` before anything is written — an
 * installation id names an account's source code, and the token the repository
 * capabilities mint through it carries no caller entitlement. An id the account
 * cannot reach is `not_found: installation_unreachable`.
 */
export async function attachGithubInstallation(
  org: string,
  ws: string,
  installationId: string,
): Promise<ActionResult<AttachedInstallation>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, repositoryInstallationAttach, {
    installationId,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          connectionId: result.value.connectionId,
          accountLogin: result.value.accountLogin,
        },
      }
    : result;
}

/**
 * Every repository the workspace binds, main and linked, with each one's role.
 * Local facts only — no GitHub call — so the Repositories section draws while
 * GitHub is down, and draws the connection-retired note from the same record.
 */
export async function readWorkspaceRepositories(
  org: string,
  ws: string,
): Promise<ActionResult<WorkspaceRepositories>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: repositoryList,
    input: {},
    page: "repositories",
  });
  return readToActionResult(read);
}

/**
 * Link a repository as one of the workspace's LINKED repositories. Names only
 * the repository, as the bind does and for the same reason: the installation
 * is the workspace's own. The handler refuses the workspace's main repository
 * (`conflict: main_repo`), a repository already linked
 * (`conflict: repository_already_linked`), another workspace's main
 * repository (`conflict: main_repo_claimed`, ADR-099), one the installation
 * cannot see (`not_found: repository_not_installed`), and a workspace with
 * no installation attached (`conflict: github_not_connected`).
 */
export async function linkWorkspaceRepository(
  org: string,
  ws: string,
  repository: { owner: string; name: string },
): Promise<ActionResult<LinkedRepository>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, repositoryLink, {
    provider: "github",
    owner: repository.owner,
    name: repository.name,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          bindingId: result.value.bindingId,
          fullName: result.value.fullName,
          defaultRef: result.value.defaultRef,
          linkedAt: result.value.linkedAt,
        },
      }
    : result;
}

/**
 * Unlink a linked repository by the binding id the list answered. The head
 * goes; every binding version stays, because runs admitted against it still
 * cite it. The main repository is refused (`conflict: main_repo_unlink_refused`)
 * and the section never offers it; a binding this workspace does not see is
 * `not_found: repository_not_linked`.
 */
export async function unlinkWorkspaceRepository(
  org: string,
  ws: string,
  bindingId: string,
): Promise<ActionResult<UnlinkedRepository>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, repositoryUnlink, { bindingId });
  return result.ok
    ? {
        ok: true,
        value: {
          bindingId: result.value.bindingId,
          fullName: result.value.fullName,
          unlinkedAt: result.value.unlinkedAt,
        },
      }
    : result;
}

/**
 * What one bound repository holds under `.oxagen/` on its production branch,
 * read from GitHub now. A branch GitHub no longer has answers `head: null`
 * rather than a refusal, because the repair is on the same page.
 */
export async function readRepositoryTree(
  org: string,
  ws: string,
  bindingId: string,
): Promise<ActionResult<RepositoryTree>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: repositoryTreeGet,
    input: { bindingId },
    page: "repositories",
  });
  return readToActionResult(read);
}

/**
 * Confirm or change a repository's production branch. Naming the branch the
 * binding already records writes nothing (`changed: false`); a branch GitHub
 * does not have is `not_found: branch_not_found`. The production branch never
 * moves on its own (§11.4): this is the only way it moves.
 */
export async function setProductionBranch(
  org: string,
  ws: string,
  bindingId: string,
  branch: string,
): Promise<ActionResult<ProductionBranchSet>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, repositoryProductionBranchSet, {
    bindingId,
    branch,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          bindingId: result.value.bindingId,
          fullName: result.value.fullName,
          productionBranch: result.value.productionBranch,
          previousBranch: result.value.previousBranch,
          changed: result.value.changed,
        },
      }
    : result;
}

/**
 * Open the pull request that adds `.oxagen/` to a bound repository, from
 * `oxagen/init` into its production branch, carrying the two files the person
 * reviewed. Nothing reaches the production branch until a person merges it.
 */
export async function openInitPullRequest(
  org: string,
  ws: string,
  input: {
    bindingId: string;
    governanceMode: "solo" | "team" | "regulated";
    workspaceToml: string;
    governanceToml: string;
  },
): Promise<ActionResult<InitPullRequest>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, repositoryInitPrOpen, input);
  return result.ok
    ? {
        ok: true,
        value: {
          fullName: result.value.fullName,
          branch: result.value.branch,
          base: result.value.base,
          pullRequest: result.value.pullRequest,
          files: result.value.files,
          reused: result.value.reused,
        },
      }
    : result;
}

/** The newest proposals the Changes tab reads; the Steering page pages the rest. */
const CHANGES_LIMIT = 50;

/**
 * The pull requests Oxagen has open or merged on this workspace's
 * repositories, newest first. Every one today is a context record's Context
 * PR: a proposal with no pull request yet is not a change on GitHub, so it
 * stays on the Steering page and off this list.
 */
export async function readRepositoryChanges(
  org: string,
  ws: string,
): Promise<ActionResult<RepositoryChanges>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: contextProposalList,
    input: { limit: CHANGES_LIMIT, offset: 0 },
    page: "repositories",
  });
  if (!read.ok) return readToActionResult(read);
  const changes: RepositoryChange[] = [];
  for (const proposal of read.value.proposals) {
    if (proposal.pr === null || proposal.status === "proposed") continue;
    changes.push({
      proposalId: proposal.id,
      lineage: proposal.lineageId,
      statement: proposal.statement,
      why: proposal.rationale,
      kind: "context_record",
      pullRequest: proposal.pr,
      openedBy: proposal.source,
      status: proposal.status,
      checks: proposal.checks,
      openedAt: proposal.createdAt,
    });
  }
  return {
    ok: true,
    value: {
      changes,
      open: changes.filter(
        (change) => change.status !== "merged" && change.status !== "rejected",
      ).length,
    },
  };
}

/**
 * One change's Context PR, for the detail the Changes tab shows when a row is
 * selected: its branch and base, each check with its own result, what merge
 * will do, and the merge once it happened. `get_context_pr` is read here
 * rather than through the Steering port because this page reads on demand.
 */
export async function readRepositoryChange(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<ContextPr>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: contextPrGet,
    input: { proposalId },
    page: "repositories",
  });
  if (!read.ok) return readToActionResult(read);
  const out = read.value;
  return {
    ok: true,
    value: {
      proposalId: out.proposalId,
      lineage: out.lineageId,
      status: out.status,
      governanceMode: out.governanceMode,
      pr:
        out.pr === null
          ? null
          : {
              number: out.pr.number,
              url: out.pr.url,
              repository: out.pr.repository,
              baseRef: out.pr.baseRef,
              branch: out.pr.branch,
              headSha: out.pr.headSha,
            },
      body: out.body,
      checks: out.checks.map((check) => ({
        name: check.name,
        status: check.status,
        summary: check.summary,
      })),
      onMerge: {
        path: out.onMerge.publishes.path,
        bundleVersion: {
          current: out.onMerge.bundleVersion.current,
          afterMerge: out.onMerge.bundleVersion.afterMerge,
        },
      },
      merged:
        out.merged === null
          ? null
          : {
              commit: out.merged.commit,
              at: out.merged.at,
              promotionEventId: out.merged.promotionEventId,
              recordId: out.merged.recordId,
            },
    },
  };
}

/**
 * Merge a change once every check passed. `merge_context_pr` re-reads the
 * governance mode at merge time and gates the signed-in reviewer it names, so
 * a person the mode does not admit is refused there whatever the page drew.
 */
export async function mergeRepositoryChange(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ commit: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrMerge, { proposalId });
  return result.ok
    ? { ok: true, value: { commit: result.value.mergedCommit } }
    : result;
}

/**
 * Close a change without merging: `dismiss_proposal` closes the pull request,
 * deletes its branch and publishes nothing. The comment the dialog previews is
 * recorded as the dismissal's reason.
 */
export async function closeRepositoryChange(
  org: string,
  ws: string,
  proposalId: string,
  comment: string,
): Promise<ActionResult<{ status: "rejected" }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextProposalDismiss, {
    proposalId,
    reason: comment.trim(),
  });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}
