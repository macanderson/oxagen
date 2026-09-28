// first-commit.ts: write the seed files to `main` as the repository's first
// commit, before any ruleset exists.
//
// GitHub creates the repository with one commit on the organization's default
// branch, which may not be `main`. This step writes a parentless commit that
// holds only the seed files, points `main` at it, makes `main` the default
// branch, and deletes the branch GitHub made. A rerun finds `main` already
// holding the same tree and writes nothing.
import { seg, type GithubRest } from "./http";
import type { RepoAddress, SeedFile } from "./types";

/** The branch every steering repo publishes from. */
export const STEERING_BRANCH = "main";

export interface FirstCommitInput {
  repo: RepoAddress;
  files: readonly SeedFile[];
  message: string;
  /**
   * The branch GitHub created the repository with. The caller records it when
   * the repository is created, because a rerun after this step has changed
   * the default branch can no longer read it from GitHub.
   */
  initial_branch: string;
}

export interface FirstCommitResult {
  commit_sha: string;
  tree_sha: string;
  /** False when `main` already held these files. */
  written: boolean;
}

function base(repo: RepoAddress): string {
  return `/repos/${seg(repo.owner)}/${seg(repo.name)}`;
}

export async function writeFirstCommit(
  rest: GithubRest,
  input: FirstCommitInput,
): Promise<FirstCommitResult> {
  const root = base(input.repo);
  const tree = await rest.request<{ sha: string }>("POST", `${root}/git/trees`, {
    tree: input.files.map((f) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      content: f.content,
    })),
  });
  const treeSha = requireSha(tree.data, "tree");

  const ref = await rest.request<{ object: { sha: string } }>(
    "GET",
    `${root}/git/ref/heads/${STEERING_BRANCH}`,
    undefined,
    [404],
  );
  const headSha = ref.data?.object.sha ?? null;

  let commitSha: string | null = null;
  let written = false;
  if (headSha !== null) {
    const head = await rest.request<{ tree: { sha: string } }>(
      "GET",
      `${root}/git/commits/${seg(headSha)}`,
    );
    if (head.data?.tree.sha === treeSha) commitSha = headSha;
  }

  if (commitSha === null) {
    const commit = await rest.request<{ sha: string }>(
      "POST",
      `${root}/git/commits`,
      { message: input.message, tree: treeSha, parents: [] },
    );
    commitSha = requireSha(commit.data, "commit");
    if (headSha === null) {
      await rest.request("POST", `${root}/git/refs`, {
        ref: `refs/heads/${STEERING_BRANCH}`,
        sha: commitSha,
      });
    } else {
      // The branch holds GitHub's own first commit, which the seed replaces.
      await rest.request("PATCH", `${root}/git/refs/heads/${STEERING_BRANCH}`, {
        sha: commitSha,
        force: true,
      });
    }
    written = true;
  }

  if (input.initial_branch !== STEERING_BRANCH) {
    const current = await rest.request<{ default_branch: string }>("GET", root);
    if (current.data?.default_branch !== STEERING_BRANCH)
      await rest.request("PATCH", root, { default_branch: STEERING_BRANCH });
    // The branch GitHub created holds nothing Oxagen wrote. A 404 or 422
    // means an earlier run already deleted it.
    await rest.request(
      "DELETE",
      `${root}/git/refs/heads/${input.initial_branch
        .split("/")
        .map((s) => seg(s))
        .join("/")}`,
      undefined,
      [404, 422],
    );
  }

  return { commit_sha: commitSha, tree_sha: treeSha, written };
}

function requireSha(data: { sha: string } | null, what: string): string {
  if (data === null || typeof data.sha !== "string" || data.sha.length === 0)
    throw new Error(`GitHub returned no ${what} sha`);
  return data.sha;
}
