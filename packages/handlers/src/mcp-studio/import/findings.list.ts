// findings.list.ts: list_studio_findings (mcp-studio-spec, lane M9).
//
// Studio's findings panel shows what the tool checks say about one server
// folder before anyone opens a Review. The handler reads what Review reads
// and builds the folder with the same code (build.ts), so the panel and the
// steering PR's body cannot disagree:
//
//   1. Read the saved draft. A server with no draft is checked as the
//      production branch holds it.
//   2. Resolve the production branch to one commit and read the folder there.
//   3. Import the draft's source again, when the draft has one.
//   4. Build the folder in report mode: compile, lock, and lint. An imported
//      tool with no classification comes back as an error finding instead of
//      a refusal.
//
// The handler writes nothing. A folder that does not compile or lock is
// refused with `conflict`, as Review refuses it, because lint needs a
// compiled folder to read. A published gRPC folder is refused the same way
// (source_required), because its descriptors live only in a draft's source.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  toolStudioFindingsList,
  type ToolStudioFindingsListOutput,
} from "@oxagen/oxagen/contracts/tool.studio.findings.list";
import type { StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { SERVER_TOML_NAME, serverFolderPath } from "@oxagen/oxagen/steering-repo/paths";
import type { SteeringRepository } from "../../context.steering.github";
import { toolsSteeringHost, type ToolsPullRequestScope } from "../../tools.pr.open";
import { buildFolder, type BuiltFolder } from "./build";
import { authorizeStudio } from "./checks";
import { readFolder, workspaceCredentials, type StudioReviewHost } from "./review.open";
import { importSource, type ImportedSource } from "./source";
import { postgresStudioDraftStore, type StoredStudioDraft, type StudioDraftStore } from "./store";

export interface ListStudioFindingsDeps {
  store: Pick<StudioDraftStore, "get">;
  authorize: typeof authorizeStudio;
  host: () => Pick<StudioReviewHost, "resolveRepository" | "branchHead" | "readFile" | "listFiles">;
  /** The workspace's credential references, `oxagen:credential/<name>`. */
  credentials: (scope: ToolsPullRequestScope) => Promise<ReadonlySet<string>>;
  importSource: (source: StudioSource) => Promise<ImportedSource>;
}

/** A server folder as Studio sees it now, and the draft it was built from. */
export interface StudioFolderView {
  folder: BuiltFolder;
  /** The saved draft, or null when the folder is production's. */
  draft: StoredStudioDraft | null;
  /** The steering repository the folder was read from. */
  repo: SteeringRepository;
  /**
   * The production branch's commit the folder was read at. A caller that
   * reads a file Review does not manage, such as tests/selection.jsonl, reads
   * it at this commit so both reads see one tree.
   */
  productionSha: string;
}

/**
 * Build one server folder the way Review does, in report mode, without writing
 * anything: the saved draft, or production's folder when there is no draft.
 * Draft reads a tool's definition from the same build, so the findings panel
 * and the Draft button see one folder.
 */
export async function buildStudioFolderView(
  deps: Omit<ListStudioFindingsDeps, "authorize">,
  scope: ToolsPullRequestScope,
  server: string,
): Promise<StudioFolderView> {
  const draft = await deps.store.get(scope, server);
  const host = deps.host();
  const repo = await host.resolveRepository(scope);
  const productionSha = await host.branchHead(repo, repo.defaultBranch);
  if (productionSha === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "production_branch_missing",
      message: `${repo.fullName} has no ${repo.defaultBranch} branch.`,
    });
  }
  const [production, credentials, imported] = await Promise.all([
    readFolder(host, repo, productionSha, server),
    deps.credentials(scope),
    draft === null || draft.source === null ? Promise.resolve(null) : deps.importSource(draft.source),
  ]);
  if (draft === null && !production.has(SERVER_TOML_NAME)) {
    throw new HandlerError({
      code: "not_found",
      reason: "folder_not_found",
      message: `${server} has no draft, and ${repo.fullName} has no ${serverFolderPath(server)}/${SERVER_TOML_NAME} on ${repo.defaultBranch}. Set up the server's connection in Studio first.`,
    });
  }

  // With no draft, an empty one: no ops, production's server.toml, and no
  // source, so the build reads the production lock's tools.
  const folder = buildFolder({
    draft: draft ?? { server, ops: [], serverToml: null, source: null },
    imported,
    production,
    credentials,
    unclassified: "report",
  });
  return { folder, draft, repo, productionSha };
}

export function createListStudioFindingsHandler(
  deps: ListStudioFindingsDeps,
): CapabilityHandler<typeof toolStudioFindingsList> {
  return async (input, ctx): Promise<ToolStudioFindingsListOutput> => {
    await deps.authorize(toolStudioFindingsList, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { folder, draft } = await buildStudioFolderView(deps, scope, input.server);
    return {
      server: folder.server,
      basis: draft === null ? "published" : "draft",
      revision: draft?.revision ?? null,
      tokens: folder.tokens,
      findings: folder.findings,
    };
  };
}

export const listStudioFindingsHandler = createListStudioFindingsHandler({
  store: postgresStudioDraftStore(),
  authorize: authorizeStudio,
  host: toolsSteeringHost,
  credentials: workspaceCredentials,
  importSource: (source) => importSource(source),
});
