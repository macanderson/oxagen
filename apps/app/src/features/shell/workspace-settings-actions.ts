"use server";
// What the Workspace settings dialog reads and writes: the workspace's main
// repository, the repositories its GitHub App installation reaches, the bind
// that turns the second into the first (MC spec §10.1–§10.2, #2967), and the
// Repositories section's list, link and unlink (§10.1, §17 M0: "a second repo
// can be linked and unlinked").
//
// These are reads made on demand rather than through a DataSource port,
// because the dialog is shell chrome. The organization layout renders the
// chrome above every page and resolves an `OrgCtx`; the workspace is in the
// URL, which only the client knows, and `list_installation_repositories` is a
// live call to GitHub. A port read would therefore either have the wrong ctx
// or charge every workspace page for a network round trip nobody asked for. So
// the dialog asks when a person opens it, through this module, which resolves
// its own viewer exactly as a write does (§3.3, and the `features` row of §2).
//
// `bind_main_repository` also has an action in features/onboarding: the
// provisional banner binds the one repository the enrolling host reported.
// This one binds the repository a person picked out of the installation. Each
// feature owns its own actions (§2 admits no edge between two features), and
// the two callers refuse differently — the banner stays where it is, the
// dialog re-reads its panel — so the duplication is the seam, not an accident.
import { repositoryInstallationAttach } from "@oxagen/oxagen/contracts/repository.installation.attach";
import { repositoryInstallationCandidates } from "@oxagen/oxagen/contracts/repository.installation.candidates";
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import type {
  AttachedInstallation,
  GitHubInstallations,
  InstallationRepositories,
  LinkedRepository,
  UnlinkedRepository,
  WorkspaceRepositories,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import type { Read } from "@/data/read";
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
    page: "workspaceSettings",
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
    page: "workspaceSettings",
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
    page: "workspaceSettings",
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
    page: "workspaceSettings",
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
