// review.open.ts: open_studio_review (lane M11, ADR-224).
//
// Review turns Studio's stored draft for one server folder into one steering
// PR on the branch tools/<server>:
//
//   1. Read the draft, and refuse a stale revision.
//   2. Resolve the production branch to a commit, and read the folder's
//      managed files at that commit.
//   3. Import the draft's source again, so the PR is built from inputs.
//   4. Build the folder (build.ts). The build refuses while an imported tool
//      has no risk, side effect, or egress, and while the folder does not
//      compile or lock.
//   5. Open the PR through the tools steering PR path (tools.pr.open.ts). An
//      open PR on the branch gets a new commit instead of a second PR.
//      Review passes the commit it read as `at`: a new branch starts there,
//      and a branch that moved since the read is refused.
//   6. Record the PR on the draft.
//
// The commit holds only the files that differ from the branch it lands on.
// When nothing differs, Review refuses with `conflict` (draft_unchanged), so a
// second Review of the same draft never adds an empty commit.
import { HandlerError, isHandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  toolStudioReviewOpen,
  type ToolStudioReviewOpenOutput,
} from "@oxagen/oxagen/contracts/tool.studio.review.open";
import type { StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { CREDENTIAL_REF_PREFIX } from "@oxagen/oxagen/steering-repo/names";
import { serverFolderPath } from "@oxagen/oxagen/steering-repo/paths";
import type { SteeringRepository } from "../../context.steering.github";
import { actingAuthor } from "../../steering-repo/pr-proposal";
import {
  TOOLS_BRANCH_PREFIX,
  toolsPullRequestOpener,
  toolsSteeringHost,
  type ToolsPullRequestArgs,
  type ToolsPullRequestHost,
  type ToolsPullRequestOpener,
  type ToolsPullRequestResult,
  type ToolsPullRequestScope,
} from "../../tools.pr.open";
import { reviewBody, reviewCommitMessage, reviewTitle } from "./body";
import { buildFolder, folderCommit, isManagedPath } from "./build";
import { authorizeStudio } from "./checks";
import { importSource, type ImportedSource } from "./source";
import { postgresStudioDraftStore, staleRevision, type StudioDraftStore } from "./store";

/** The host reads Review makes. The opener makes the writes. */
export type StudioReviewHost = Pick<
  ToolsPullRequestHost,
  "resolveRepository" | "branchHead" | "readFile" | "listFiles" | "findOpenPullRequest"
>;

export interface OpenStudioReviewDeps {
  store: StudioDraftStore;
  authorize: typeof authorizeStudio;
  host: () => StudioReviewHost;
  opener: ToolsPullRequestOpener;
  /** The workspace's credential references, `oxagen:credential/<name>`. */
  credentials: (scope: ToolsPullRequestScope) => Promise<ReadonlySet<string>>;
  importSource: (source: StudioSource) => Promise<ImportedSource>;
}

/** Refusals from the opener that mean the recorded PR is gone, so Review opens a new one. */
const PR_GONE = new Set(["tools_pr_not_open", "tools_branch_missing"]);

/** The branch Review writes a server's folder to. */
export function reviewBranch(server: string): string {
  return `${TOOLS_BRANCH_PREFIX}${server}`;
}

/** The managed files of a server's folder at `ref`, by path relative to the folder. */
export async function readFolder(
  host: Pick<StudioReviewHost, "readFile" | "listFiles">,
  repo: SteeringRepository,
  ref: string,
  server: string,
): Promise<Map<string, string>> {
  const dir = serverFolderPath(server);
  const paths = (await host.listFiles(repo, ref, dir))
    .map((path) => path.slice(dir.length + 1))
    .filter(isManagedPath)
    .sort();
  const texts = await Promise.all(paths.map((path) => host.readFile(repo, `${dir}/${path}`, ref)));
  const files = new Map<string, string>();
  paths.forEach((path, i) => {
    const text = texts[i];
    if (text !== null && text !== undefined) files.set(path, text);
  });
  return files;
}

function unchanged(message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason: "draft_unchanged", message });
}

export function createOpenStudioReviewHandler(
  deps: OpenStudioReviewDeps,
): CapabilityHandler<typeof toolStudioReviewOpen> {
  return async (input, ctx): Promise<ToolStudioReviewOpenOutput> => {
    await deps.authorize(toolStudioReviewOpen, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const draft = await deps.store.get(scope, input.server);
    if (draft === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "draft_not_found",
        message: `${input.server} has no draft. Save Studio's edits, then Review.`,
      });
    }
    if (input.revision !== undefined && input.revision !== draft.revision) {
      throw staleRevision(
        `Review read revision ${input.revision} of the ${draft.server} draft, and the stored draft is at revision ${draft.revision}. Reload the draft, then Review.`,
      );
    }

    const host = deps.host();
    const repo = await host.resolveRepository(scope);
    // Read one commit, not the branch name. A merge that lands during the
    // import would otherwise sit under files built without it, and the
    // steering PR would undo it.
    const productionSha = await host.branchHead(repo, repo.defaultBranch);
    if (productionSha === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "production_branch_missing",
        message: `${repo.fullName} has no ${repo.defaultBranch} branch.`,
      });
    }
    const [production, credentials, imported] = await Promise.all([
      readFolder(host, repo, productionSha, draft.server),
      deps.credentials(scope),
      draft.source === null ? Promise.resolve(null) : deps.importSource(draft.source),
    ]);
    const folder = buildFolder({ draft, imported, production, credentials });

    const branch = reviewBranch(draft.server);
    const message = {
      branch,
      title: reviewTitle(folder),
      body: reviewBody(folder, draft.revision),
      commitMessage: reviewCommitMessage(folder, draft.revision),
      // The PR's proposal row names the person who opened the Review (#5122).
      author: await actingAuthor(ctx),
    } satisfies Omit<ToolsPullRequestArgs, "files">;

    // An open PR on the branch gets a commit against the branch's files, read
    // at one commit so the opener can refuse a branch that moved.
    let result: ToolsPullRequestResult | null = null;
    const open = await host.findOpenPullRequest(repo, { head: branch, base: repo.defaultBranch });
    const branchSha = open === null ? null : await host.branchHead(repo, branch);
    if (open !== null && branchSha !== null) {
      const onBranch = await readFolder(host, repo, branchSha, draft.server);
      const files = folderCommit(draft.server, folder.files, onBranch);
      if (files.length === 0) {
        throw unchanged(`Steering PR #${open.number} already holds every edit in the ${draft.server} draft.`);
      }
      try {
        result = await deps.opener.open(scope, {
          ...message,
          files,
          existing: { number: open.number },
          at: branchSha,
        });
      } catch (err) {
        // The PR closed, or its branch went, between the read and the write.
        if (!(isHandlerError(err) && PR_GONE.has(err.reason))) throw err;
      }
    }
    if (result === null) {
      const files = folderCommit(draft.server, folder.files, production);
      if (files.length === 0) {
        throw unchanged(
          `The ${draft.server} draft matches ${repo.defaultBranch}, so a steering PR would change nothing. Edit the server's tools, then Review.`,
        );
      }
      result = await deps.opener.open(scope, { ...message, files, at: productionSha });
    }

    await deps.store.recordPr(scope, draft.server, {
      number: result.number,
      url: result.url,
      branch: result.branch,
    });
    return {
      number: result.number,
      url: result.url,
      branch: result.branch,
      headSha: result.headSha,
      imported: folder.imported,
      removed: folder.removed,
      reclassified: folder.reclassified,
      tokens: folder.tokens,
      findings: folder.findings,
    };
  };
}

/** The workspace's credentials as references. The names come back, never a secret. */
export async function workspaceCredentials(scope: ToolsPullRequestScope): Promise<ReadonlySet<string>> {
  const { readCheckContext } = await import("../../context.steering.index.get");
  const context = await readCheckContext(scope);
  return new Set(context.credentials.map((name) => `${CREDENTIAL_REF_PREFIX}${name}`));
}

export const openStudioReviewHandler = createOpenStudioReviewHandler({
  store: postgresStudioDraftStore(),
  authorize: authorizeStudio,
  host: toolsSteeringHost,
  opener: toolsPullRequestOpener,
  credentials: workspaceCredentials,
  importSource: (source) => importSource(source),
});
