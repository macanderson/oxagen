// first-commit.ts: write the seed files to main in one commit.
//
// A rerun reads main first. When main already holds exactly the seed files,
// the step writes nothing and returns the head it found. Otherwise it sends
// one commit whose create, update, and delete actions leave main holding
// exactly the seed files. The settings step protects main later, so this
// step can still push to it.
import { requireData, seg } from "./http";
import type { GitlabRest } from "./http";
import type { SeedFile } from "./types";

/** The branch the steering repo keeps its rules on. */
export const STEERING_BRANCH = "main";

const TREE_PAGE_SIZE = 100;
const MAX_TREE_PAGES = 100;

interface BranchBody {
  name: string;
  commit: { id: string };
}

interface TreeEntryBody {
  path: string;
  type: string;
}

interface FileBody {
  content: string;
}

interface CommitBody {
  id: string;
}

type CommitAction =
  | { action: "create" | "update"; file_path: string; content: string }
  | { action: "delete"; file_path: string };

/** The head sha of main, or null when main does not exist yet. */
async function headOf(rest: GitlabRest, root: string): Promise<string | null> {
  const res = await rest.request<BranchBody>(
    "GET",
    `${root}/repository/branches/${seg(STEERING_BRANCH)}`,
    undefined,
    [404],
  );
  if (res.status === 404) return null;
  return requireData(res, "branch").commit.id;
}

/**
 * Every file path on main. `HttpFetch` exposes no headers, so the helper
 * cannot read GitLab's page links. It asks for the next page until one comes
 * back short.
 */
async function listFiles(rest: GitlabRest, root: string): Promise<string[]> {
  const paths: string[] = [];
  for (let page = 1; page <= MAX_TREE_PAGES; page++) {
    const res = await rest.request<TreeEntryBody[]>(
      "GET",
      `${root}/repository/tree?ref=${seg(STEERING_BRANCH)}&recursive=true&per_page=${TREE_PAGE_SIZE}&page=${page}`,
    );
    const entries = requireData(res, "tree");
    for (const entry of entries) if (entry.type === "blob") paths.push(entry.path);
    if (entries.length < TREE_PAGE_SIZE) return paths;
  }
  throw new Error(
    `The steering repo holds more than ${TREE_PAGE_SIZE * MAX_TREE_PAGES} tree entries on ${STEERING_BRANCH}, so provisioning stopped reading it.`,
  );
}

/**
 * One file's content on main. The JSON files endpoint always sends content
 * in base64, which keeps a seed file that holds JSON from being parsed.
 */
async function readFile(
  rest: GitlabRest,
  root: string,
  path: string,
): Promise<string> {
  const res = await rest.request<FileBody>(
    "GET",
    `${root}/repository/files/${seg(path)}?ref=${seg(STEERING_BRANCH)}`,
  );
  return Buffer.from(requireData(res, "file").content, "base64").toString("utf8");
}

/** The actions that make main hold exactly `files`. */
async function actionsFor(
  rest: GitlabRest,
  root: string,
  files: readonly SeedFile[],
): Promise<CommitAction[]> {
  const present = new Set(await listFiles(rest, root));
  const seeds = new Set(files.map((f) => f.path));
  const actions: CommitAction[] = [];
  for (const file of files) {
    if (!present.has(file.path)) {
      actions.push({ action: "create", file_path: file.path, content: file.content });
    } else if ((await readFile(rest, root, file.path)) !== file.content) {
      actions.push({ action: "update", file_path: file.path, content: file.content });
    }
  }
  for (const path of [...present].sort())
    if (!seeds.has(path)) actions.push({ action: "delete", file_path: path });
  return actions;
}

/**
 * Put the seed files on main. On an empty project the step creates main with
 * one commit. On a rerun it writes only when main differs from the seed
 * files, and `written` says whether it did.
 */
export async function writeFirstCommit(
  rest: GitlabRest,
  input: { project_id: number; files: readonly SeedFile[]; message: string },
): Promise<{ commit_sha: string; written: boolean }> {
  const root = `/projects/${seg(input.project_id)}`;
  const head = await headOf(rest, root);
  let actions: CommitAction[];
  if (head === null) {
    actions = input.files.map((f): CommitAction => ({
      action: "create",
      file_path: f.path,
      content: f.content,
    }));
  } else {
    actions = await actionsFor(rest, root, input.files);
    if (actions.length === 0) return { commit_sha: head, written: false };
  }
  const res = await rest.request<CommitBody>(
    "POST",
    `${root}/repository/commits`,
    { branch: STEERING_BRANCH, commit_message: input.message, actions },
  );
  return { commit_sha: requireData(res, "commit").id, written: true };
}
