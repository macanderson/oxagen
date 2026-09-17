"use server";
// What the Workspace settings dialog reads and writes: the workspace's main
// repository, the repositories its GitHub App installation reaches, and the
// bind that turns the second into the first (MC spec §10.1–§10.2, #2967).
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
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  InstallationRepositories,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import type { Read } from "@/data/read";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type BoundRepository = {
  fullName: string;
  defaultRef: string;
  boundAt: string;
};

/**
 * A read, as the dialog consumes it. Every caller here is a client component,
 * and INV-19 has every exported function of a `"use server"` module answer
 * with an `ActionResult`, so the `Read` the seam produces is carried across in
 * the same shape a write's refusal takes: `denied` keeps the permission the
 * page failure names, and an error keeps its code.
 */
function asActionResult<T>(read: Read<T>): ActionResult<T> {
  if (read.ok) return read;
  switch (read.reason) {
    case "denied":
      return { ok: false, reason: "denied", code: read.permission };
    case "pending_approval":
      return {
        ok: false,
        reason: "pending_approval",
        accessRequestId: read.accessRequestId,
      };
    case "error":
      return { ok: false, reason: "unavailable", code: read.code };
  }
}

/** The mapped record parsed at the boundary; one the view model refuses is `record_unmappable`, reported once. */
function view<S extends z.ZodType>(
  orgId: string,
  schema: S,
  result: ActionResult<z.input<S>>,
  read: string,
): ActionResult<z.output<S>> {
  if (!result.ok) return result;
  const parsed = schema.safeParse(result.value);
  if (parsed.success) return { ok: true, value: parsed.data };
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${read} record_unmappable`,
  });
  return { ok: false, reason: "unavailable", code: "record_unmappable" };
}

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
  return view(
    ctx.orgId,
    WorkspaceRepository,
    asActionResult(read),
    "repository.main",
  );
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
  return view(
    ctx.orgId,
    InstallationRepositories,
    asActionResult(read),
    "repository.installations",
  );
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
