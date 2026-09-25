// context.steering.published.get.ts — `get_published_steering`, the read
// behind `oxagen pull`.
//
// Flow:
//   1. The repository: the binding the caller named
//      (`not_found: repository_not_linked`), or with no binding id, the
//      workspace's main repository (`conflict: main_repo_unbound`), because
//      the main repository's `.oxagen/` is the one that steers the workspace.
//   2. A client for the workspace's installation
//      (`conflict: github_not_connected`), and the repository as GitHub
//      reports it, checked against the immutable id the binding was made
//      against (`not_found: repository_not_installed`).
//   3. The production branch's head. A branch GitHub no longer has answers
//      `head: null` and no files, as `get_repository_tree` does.
//   4. Every blob under `.oxagen/` at that head except `workspace.json`,
//      refused as `conflict: steering_too_large` past
//      PUBLISHED_STEERING_MAX_FILES rather than cut, then each file's text read
//      at the same commit, eight at a time.
//
// No store is written. Every fact here is GitHub's, read at call time.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  PUBLISHED_STEERING_MAX_FILES,
  publishedSteeringGet,
  type PublishedSteeringGetOutput,
} from "@oxagen/oxagen/contracts/context.steering.published.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import {
  readBoundRepository,
  repositoryHostUnsupported,
  requireBoundRepoInfo,
  requireWorkspaceGithub,
  selectBoundRepository,
  workspaceGithub,
  type BoundRepository,
  type WorkspaceGithub,
} from "./repository.bound";
import { OXAGEN_DIR } from "./repository.tree.get";

type Scope = { orgId: string; workspaceId: string };

/** A machine's link to its workspace. Gitignored, and never published. */
export const WORKSPACE_JSON_PATH = ".oxagen/workspace.json";

/** How many file reads one pull keeps in flight against GitHub. */
export const FILE_READ_CONCURRENCY = 8;

export interface PublishedSteeringDeps {
  github: WorkspaceGithub;
  readBound: typeof readBoundRepository;
  readMain: (scope: Scope) => Promise<BoundRepository>;
  now: () => Date;
}

/** The refusal for a pull that names no repository in a workspace with no main one. */
export function mainRepoUnbound(): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "main_repo_unbound",
    message:
      "This workspace has no main repository, so it has no published steering. Bind one from the Repositories page, or name a repository by its binding id.",
  });
}

/**
 * The workspace's main repository: the head whose role is `main`, through its
 * current binding. Refuses `conflict: main_repo_unbound` without one and
 * `conflict: repository_host_unsupported` for a GitLab project.
 */
export async function readMainBoundRepository(
  scope: Scope,
): Promise<BoundRepository> {
  const bound = await withTenantDb(async (tx) => {
    const [main] = await tx
      .select({ bindingId: schema.repositoryBindings.publicId })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          eq(schema.repositoryBindingHeads.role, "main"),
        ),
      )
      .limit(1);
    if (!main) return null;
    return selectBoundRepository(tx, scope, main.bindingId);
  });
  if (!bound) throw mainRepoUnbound();
  if (bound.provider !== "github")
    throw repositoryHostUnsupported(bound.fullName);
  return bound;
}

/** The published paths in a tree: under `.oxagen/`, without the machine link, sorted. */
export function publishedPaths(tree: readonly string[]): string[] {
  return tree
    .filter(
      (path) => path.startsWith(OXAGEN_DIR) && path !== WORKSPACE_JSON_PATH,
    )
    .sort();
}

/** `fn` over `items` with at most `limit` calls in flight, answers in input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

export function createPublishedSteeringGetHandler(
  deps: PublishedSteeringDeps,
): CapabilityHandler<typeof publishedSteeringGet> {
  return async (input, ctx): Promise<PublishedSteeringGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const bound =
      input.bindingId === undefined
        ? await deps.readMain(scope)
        : await deps.readBound(scope, input.bindingId);
    const gh = await requireWorkspaceGithub(deps.github, scope);
    // The repository GitHub holds at these coordinates must still be the one
    // the binding was made against, or a re-created repository's files would
    // be written onto a machine as this workspace's steering.
    await requireBoundRepoInfo(gh, bound);
    const at = { owner: bound.owner, repo: bound.name };

    const branch = await gh.getBranch({
      ...at,
      branch: bound.productionBranch,
    });
    const head = branch?.sha ?? null;

    let files: PublishedSteeringGetOutput["files"] = [];
    if (head !== null) {
      // The tree and every file are read at the head commit, never the
      // branch, so a push landing mid-read cannot mix two commits.
      // `getTree` answers blobs only, so every path here is a file.
      const paths = publishedPaths(await gh.getTree({ ...at, ref: head }));
      if (paths.length > PUBLISHED_STEERING_MAX_FILES) {
        throw new HandlerError({
          code: "conflict",
          reason: "steering_too_large",
          message: `${bound.fullName} holds ${paths.length} files under .oxagen/ at ${head}. A pull returns at most ${PUBLISHED_STEERING_MAX_FILES}.`,
        });
      }
      const read = await mapWithConcurrency(
        paths,
        FILE_READ_CONCURRENCY,
        async (path) => {
          const content = await gh.getFileContent({ ...at, path, ref: head });
          return content === null ? null : { path, content };
        },
      );
      // A path the tree listed at this commit is there to read; a null means
      // GitHub answered 404 for it anyway, and a pull writes no file it
      // could not read.
      files = read.filter(
        (file): file is { path: string; content: string } => file !== null,
      );
    }

    return {
      bindingId: bound.bindingId,
      role: bound.role,
      fullName: bound.fullName,
      productionBranch: bound.productionBranch,
      head,
      files,
      readAt: deps.now().toISOString(),
    };
  };
}

export const publishedSteeringGetHandler = createPublishedSteeringGetHandler({
  github: workspaceGithub,
  readBound: readBoundRepository,
  readMain: readMainBoundRepository,
  now: () => new Date(),
});
