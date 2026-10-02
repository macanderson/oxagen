// owned.ts: the files and blocks only Oxagen writes. A steering PR may not
// change the Cedar schema or the ledger, and may not change the managed block
// in AGENTS.md, CLAUDE.md, or README.md.
//
// A steering PR may add or change a server's lock only as Oxagen writes it:
// Studio's Review and a sync each write the new lock into the steering PR
// they open (mcp-studio-spec, Lock file; ADR-278). The caller's lock reader
// (ServerReaders.lock) says whether the head's lock is one Oxagen writes for
// its folder. Without that reader, the check refuses every change to a lock,
// and it always refuses a removed lock.
import {
  AGENTS_MD_PATH,
  CLAUDE_MD_PATH,
  classifySteeringRepoPath,
  MANAGED_BLOCK_END,
  readManagedBlock,
  README_PATH,
  type SteeringRepoFileKind,
} from "@oxagen/oxagen/steering-repo";
import { finder, sentence, type ChangeCheck, type ChangeEnv } from "../finding";
import { firstDifferingLine } from "../repo";
import type { Finding, SteeringTree } from "../types";

const find = finder("owned");

/** What each file only Oxagen writes holds, and when Oxagen writes it. */
const OXAGEN_WRITES: Partial<Record<SteeringRepoFileKind, string>> = {
  "cedar-schema": "the Cedar schema, which Oxagen writes on publish from the imported tools and agents/",
  "server-lock": "a server's reviewed upstream definitions, which Oxagen writes when it syncs the server",
  ledger: "the promotion ledger, which Oxagen writes when it stamps a merged steering PR",
};

/** The files that carry a managed block. */
export const MANAGED_FILES: readonly string[] = [AGENTS_MD_PATH, CLAUDE_MD_PATH, README_PATH];

const BEGIN_MARKER = "<!-- oxagen:begin managed sha256:... -->";

/** The server a lock path names: tools/servers/<name>/tools.lock.json. */
function lockServer(path: string): string {
  return path.split("/")[2] as string;
}

/** The finding for a lock the head holds that Oxagen did not write. */
function lockFinding(path: string, line: number | null, verb: string, problems: readonly string[]): Finding {
  const shown = problems.slice(0, 3).join(" ");
  const more = problems.length > 3 ? ` ${problems.length - 3} more problems follow.` : "";
  return find({
    rule: "oxagen-writes",
    path,
    line,
    field: null,
    message: `This steering PR ${verb} ${path}, and the lock it holds is not one Oxagen writes. ${shown}${more}`,
    expected: `${path} as Studio's Review or a sync writes it.`,
    fix: `Restore ${path} from the production branch. Change the server's tools in Studio and open its Review, or sync the server, and Oxagen writes the lock.`,
  });
}

function writesFindings(env: ChangeEnv, base: SteeringTree): Finding[] {
  const findings: Finding[] = [];
  const readLock = env.servers?.lock;
  for (const path of [...env.changed, ...env.removed].sort()) {
    const kind = classifySteeringRepoPath(path);
    const what = OXAGEN_WRITES[kind];
    if (what === undefined) continue;
    const before = base.get(path);
    const after = env.head.get(path);
    const line = after === undefined ? null : before === undefined ? 1 : firstDifferingLine(before, after);
    const verb = after === undefined ? "removes" : before === undefined ? "adds" : "changes";
    if (kind === "server-lock" && after !== undefined && readLock !== undefined) {
      const outcome = readLock(lockServer(path), env.head, base);
      if (!outcome.ok) findings.push(lockFinding(path, line, verb, outcome.problems));
      continue;
    }
    findings.push(
      find({
        rule: "oxagen-writes",
        path,
        line,
        field: null,
        message: `This steering PR ${verb} ${path}. It holds ${what}.`,
        expected: `${path} as the production branch holds it.`,
        fix: `Restore ${path} from the production branch. Make the change in the files Oxagen compiles it from, and Oxagen rewrites it.`,
      }),
    );
  }
  return findings;
}

function blockFinding(path: string, line: number | null, message: string): Finding {
  return find({
    rule: "managed-block",
    path,
    line,
    field: null,
    message,
    expected: `The block between ${BEGIN_MARKER} and ${MANAGED_BLOCK_END} as Oxagen wrote it, with the hash on its begin marker.`,
    fix: `Restore the block from the production branch, and put your own notes below ${MANAGED_BLOCK_END}.`,
  });
}

function managedFinding(env: ChangeEnv, path: string): Finding | null {
  const after = env.head.get(path);
  const before = env.base?.get(path);
  const prior = before === undefined ? null : readManagedBlock(before);
  const priorBlock = prior?.ok ? prior.block : null;
  if (after === undefined) {
    return priorBlock === null
      ? null
      : blockFinding(path, null, `This steering PR removes ${path} and the managed block Oxagen writes in it.`);
  }
  const read = readManagedBlock(after);
  if (!read.ok) return blockFinding(path, read.issue.line, `${path}: ${sentence(read.issue.message)}`);
  const block = read.block;
  if (block === null) {
    return priorBlock === null
      ? null
      : blockFinding(path, 1, `This steering PR removes the managed block from ${path}.`);
  }
  if (!block.intact) {
    return blockFinding(
      path,
      block.begin_line,
      `The managed block in ${path} was edited. Its text hashes to ${block.actual_hash}, and its begin marker says ${block.declared_hash}.`,
    );
  }
  if (priorBlock !== null && priorBlock.content !== block.content) {
    return blockFinding(path, block.begin_line, `This steering PR rewrites the managed block in ${path}.`);
  }
  return null;
}

export const ownedCheck: ChangeCheck = (env) => {
  const findings = env.base === null ? [] : writesFindings(env, env.base);
  for (const path of MANAGED_FILES) {
    // With a base, only a changed or removed file can break its block.
    if (env.base !== null && !env.changed.has(path) && !env.removed.has(path)) continue;
    const finding = managedFinding(env, path);
    if (finding !== null) findings.push(finding);
  }
  return {
    findings,
    note: env.base === null ? "With no production branch to compare, only the managed blocks were read." : undefined,
  };
};
