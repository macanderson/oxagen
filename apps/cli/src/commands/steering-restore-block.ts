/**
 * `oxagen steering restore-block <proposal-id> <path>`: put Oxagen's managed
 * block back in one file of an open steering PR (restore_managed_block,
 * #4518; steering-repo-spec, Managed blocks).
 *
 * AGENTS.md, CLAUDE.md, and README.md in a steering repo each hold a block
 * between two marker lines that only Oxagen writes. The `owned` check fails a
 * steering PR that changes one. This writes one commit on the PR's branch
 * that makes the block match the production branch again, and keeps every
 * line outside it. The six checks then run on the new commit.
 *
 * The API refuses, and writes nothing, when the block already matches the
 * production branch (`block_intact`), when the production branch holds no
 * block in the file (`no_managed_block`), when the repository is not a
 * steering repo (`no_managed_blocks`), and when the PR is not open.
 *
 * The call is POST `context/prs/restore-block` on the org-scoped API, through
 * the shared client in lib/api.ts.
 *
 * Output discipline (ADR-023 §4): `--json` prints the contract's answer as
 * one line on stdout. A bad argument exits 2 before any request. A refusal or
 * an API failure prints on stderr and exits 1.
 */
import type {
  ContextPrRestoreManagedBlockInput,
  ContextPrRestoreManagedBlockOutput,
} from "@oxagen/oxagen/contracts/context.pr.restore_managed_block";
import { apiPostOrThrow } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";
import {
  PROPOSAL_STATUS_WORDS,
  reportApiFailure,
  usageError,
} from "./steering-findings.js";

/**
 * The capability `oxagen steering restore-block` calls, by its registered
 * name. The manifest's cli layer looks for the name in apps/cli/src/commands.
 */
export const STEERING_RESTORE_BLOCK_CAPABILITIES = [
  "restore_managed_block",
] as const;

type ManagedBlockFile = ContextPrRestoreManagedBlockInput["path"];

/**
 * The files that hold a managed block. The CLI reads only types from a
 * contract module, so the names are written here. The record type makes the
 * build fail when the contract adds a file this list leaves out, or drops one
 * it keeps.
 */
const MANAGED_BLOCK_FILES: Readonly<Record<ManagedBlockFile, true>> = {
  "AGENTS.md": true,
  "CLAUDE.md": true,
  "README.md": true,
};

/** The shape of a proposal id, as the contract checks it. */
const PROPOSAL_ID = /^prp_[0-9A-Za-z]+$/;

const USAGE =
  "oxagen steering restore-block <proposal-id> <AGENTS.md|CLAUDE.md|README.md> [--json]";

/**
 * The managed-block file a path names, or null. A leading `./` and the letter
 * case are ignored, so `./agents.md` names AGENTS.md. The block lives only at
 * the repository root, so a path in a folder names nothing.
 */
export function managedBlockFile(path: string): ManagedBlockFile | null {
  const name = path.trim().replace(/^\.\//, "").toLowerCase();
  const files = Object.keys(MANAGED_BLOCK_FILES) as ManagedBlockFile[];
  return files.find((file) => file.toLowerCase() === name) ?? null;
}

/**
 * `oxagen steering restore-block <proposal-id> <path> [--json]`: restore the
 * managed block in one file of the proposal's steering PR, and print the
 * commit and the status of the checks.
 */
export async function steeringRestoreBlock(
  proposalId: string,
  path: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const id = proposalId.trim();
  if (!PROPOSAL_ID.test(id)) {
    usageError(
      writer,
      `expected a proposal id that starts with prp_, got ${JSON.stringify(proposalId)}`,
      USAGE,
    );
    return;
  }
  const file = managedBlockFile(path);
  if (file === null) {
    usageError(
      writer,
      `expected AGENTS.md, CLAUDE.md, or README.md, got ${JSON.stringify(path)}`,
      USAGE,
    );
    return;
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: ContextPrRestoreManagedBlockOutput;
  try {
    result = await apiPostOrThrow<ContextPrRestoreManagedBlockOutput>(
      "context/prs/restore-block",
      { proposalId: id, path: file },
    );
  } catch (err) {
    reportApiFailure(out, writer, err);
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `Restored the managed block in ${file} on the steering PR for ${id}.`,
  );
  writer.write(`Commit: ${result.commit_sha}`);
  writer.write(`Status: ${PROPOSAL_STATUS_WORDS[result.status]}`);
}
