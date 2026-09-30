// source.ts: where a workspace's workflow files live, and how they load.
//
// agent-work-spec.html (Migration): "Oxagen reads .oxagen/workflows/*.toml in a
// code repository until the workspace's steering repo holds work/workflows/,
// then offers a steering PR that moves each file and sets its schema to v0.3."
// So the steering repo wins as soon as it holds one file under work/workflows/,
// and the code repository's files are read only before that.
//
// Both functions take what the caller already read. selectWorkflowFiles takes
// each repository's file paths, and loadWorkflows takes the chosen files' text
// and a TOML parser, so this module reads no disk and no network.
import { isWorkflowSlug, parseWorkflow, type ResolvedWorkflow, type WorkflowProblem } from "./parse";

/** The steering repo's workflow directory. */
export const STEERING_WORKFLOWS_DIR = "work/workflows/";

/** The code repository's workflow directory, read until the steering repo holds one. */
export const CODE_WORKFLOWS_DIR = ".oxagen/workflows/";

export type WorkflowSource = "steering" | "code" | "none";

/** One workflow file a repository holds. */
export interface WorkflowFileRef {
  /** The path from the repository root. */
  path: string;
  /** The file name without .toml. */
  slug: string;
}

export interface WorkflowFileSelection {
  source: WorkflowSource;
  files: WorkflowFileRef[];
  /** Files in the chosen directory whose names are not slugs. Oxagen skips them. */
  skipped: string[];
}

/** The *.toml files directly inside `dir`, sorted by path. */
function filesIn(paths: readonly string[], dir: string): { files: WorkflowFileRef[]; skipped: string[] } {
  const files: WorkflowFileRef[] = [];
  const skipped: string[] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!path.startsWith(dir)) continue;
    const name = path.slice(dir.length);
    if (name.includes("/") || !name.endsWith(".toml")) continue;
    const slug = name.slice(0, -".toml".length);
    if (isWorkflowSlug(slug)) files.push({ path, slug });
    else skipped.push(path);
  }
  return { files, skipped };
}

/**
 * Choose the directory Oxagen reads workflows from. `steering` and `code` are
 * the file paths each repository holds, from its root. `code` is null when the
 * workspace has no code repository.
 */
export function selectWorkflowFiles(repos: {
  steering: readonly string[];
  code: readonly string[] | null;
}): WorkflowFileSelection {
  if (repos.steering.some((path) => path.startsWith(STEERING_WORKFLOWS_DIR))) {
    return { source: "steering", ...filesIn(repos.steering, STEERING_WORKFLOWS_DIR) };
  }
  if (repos.code !== null && repos.code.some((path) => path.startsWith(CODE_WORKFLOWS_DIR))) {
    return { source: "code", ...filesIn(repos.code, CODE_WORKFLOWS_DIR) };
  }
  return { source: "none", files: [], skipped: [] };
}

/** A workflow file that did not load, with every problem found. */
export interface WorkflowFileProblems {
  path: string;
  problems: WorkflowProblem[];
}

export interface LoadedWorkflows {
  workflows: ResolvedWorkflow[];
  failed: WorkflowFileProblems[];
}

/** Parse each file. A file that fails keeps its problems and never hides the others. */
export function loadWorkflows(
  files: readonly (WorkflowFileRef & { text: string })[],
  parseToml: (text: string) => unknown,
): LoadedWorkflows {
  const workflows: ResolvedWorkflow[] = [];
  const failed: WorkflowFileProblems[] = [];
  for (const file of files) {
    let doc: unknown;
    try {
      doc = parseToml(file.text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failed.push({ path: file.path, problems: [{ code: "not_toml", path: "", message: `The file is not TOML: ${detail}` }] });
      continue;
    }
    const result = parseWorkflow(doc, file.slug);
    if (result.ok) workflows.push(result.workflow);
    else failed.push({ path: file.path, problems: result.problems });
  }
  return { workflows, failed };
}
