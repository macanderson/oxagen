// always-on.ts: the steering that reaches every request of a run on one code
// repository, rendered the way the published bundle renders it. The budget
// check compares the block before and after a steering PR.
//
// A record is always on when isAlwaysOn says so and it names no skills: a
// record with skills reaches a request only while that skill runs. A
// repository-scoped record joins only the blocks of the repositories it names.
import { countTokens, isAlwaysOn, recordStatement } from "@oxagen/oxagen/steering-repo";
import { recordFiles, workspaceRepositories, type RecordFile } from "./repo";
import type { SteeringTree } from "./types";

/** The heading every always-on block opens with. */
export const ALWAYS_ON_HEADING = "## Workspace rules";

/** One record in an always-on block. */
export interface AlwaysOnEntry {
  lineage: string;
  path: string;
  label: string;
  /** The tokens the record's part of the block costs. */
  tokens: number;
}

/** The always-on steering for runs on one code repository. */
export interface AlwaysOnBlock {
  /** The repository, or null for a run on a repository no record names. */
  repository: string | null;
  text: string;
  tokens: number;
  /** The records in the block, in its order. */
  entries: AlwaysOnEntry[];
}

function reaches(file: RecordFile, repository: string | null): boolean {
  const record = file.record;
  if (record === null || !isAlwaysOn(record) || (record.skills?.length ?? 0) > 0) return false;
  if (record.scope !== "repository") return true;
  return repository !== null && (record.repos ?? []).includes(repository);
}

function part(file: RecordFile): string {
  return `### ${file.record?.label ?? ""}\n${recordStatement(file.body)}\n`;
}

/** The always-on block for one repository, from the tree's record files. */
export function alwaysOnBlock(files: readonly RecordFile[], repository: string | null): AlwaysOnBlock {
  const members = files
    .filter((file) => file.lineage !== null && reaches(file, repository))
    .sort((a, b) => ((a.lineage as string) < (b.lineage as string) ? -1 : 1));
  const parts = members.map(part);
  const text = parts.length === 0 ? "" : `${ALWAYS_ON_HEADING}\n\n${parts.join("\n")}`;
  return {
    repository,
    text,
    tokens: countTokens(text),
    entries: members.map((file, n) => ({
      lineage: file.lineage as string,
      path: file.path,
      label: file.record?.label ?? "",
      tokens: countTokens(parts[n] as string),
    })),
  };
}

/**
 * The always-on block of every code repository the tree names: each one
 * workspace.toml links or a record names, then the block for any other
 * repository.
 */
export function alwaysOnBlocks(tree: SteeringTree): AlwaysOnBlock[] {
  const files = recordFiles(tree);
  const repositories = new Set(workspaceRepositories(tree) ?? []);
  for (const file of files) {
    for (const repo of file.record?.repos ?? []) repositories.add(repo);
  }
  const blocks: AlwaysOnBlock[] = [...repositories].sort().map((repo) => alwaysOnBlock(files, repo));
  blocks.push(alwaysOnBlock(files, null));
  return blocks;
}
