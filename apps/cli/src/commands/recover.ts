/**
 * `oxagen recover` — find and restore agent work from the commit ledger.
 *
 * Every commit an agent makes is recorded (see ./commit-ledger.ts), so work is
 * never lost even if a branch was force-moved or a worktree removed — the commit
 * object survives until git gc.
 *
 *   oxagen recover                 list recent recorded commits (this repo)
 *   oxagen recover --all           list across all repos
 *   oxagen recover --json          machine-readable
 *   oxagen recover <hash>          show one entry + how to restore it
 *
 * Recovery is non-destructive: it prints the exact `git worktree add` command
 * rather than mutating your current tree.
 *
 * Output discipline (ADR-023 §4): `--json` emits one single-line JSON value on
 * stdout (a list is a JSON array; a single entry gains `commitExists`); pretty
 * mode renders the human view on stdout; a missing hash is a uniform stderr
 * error line with exit code 1.
 */
import {
  readLedger,
  commitExists,
  type CommitLedgerEntry,
} from "./commit-ledger.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface RecoverOptions {
  all?: boolean;
  json?: boolean;
  limit?: number;
}

export async function handleRecover(
  hash: string | undefined,
  opts: RecoverOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const cwd = process.cwd();

  if (hash) {
    const entry = readLedger().find(
      (e) => e.hash === hash || e.hash.startsWith(hash),
    );
    if (!entry) {
      out.error(
        `No ledger entry for commit ${hash}. Run \`oxagen recover\` to list what's recorded.`,
        "not_found",
      );
      return;
    }
    const exists = commitExists(entry.hash, entry.cwd);
    out.data({ ...entry, commitExists: exists }, () =>
      prettyEntry(entry, exists),
    );
    return;
  }

  const entries = readLedger({
    ...(opts.all ? {} : { cwd }),
    limit: opts.limit ?? 30,
  });
  out.data(entries, () => prettyList(entries, opts.all ?? false, cwd));
}

function prettyEntry(entry: CommitLedgerEntry, exists: boolean): string {
  const lines = [
    `commit ${entry.hash}${exists ? "" : "  (⚠ object not found in repo — may have been gc'd)"}`,
    `  when:    ${entry.at}`,
    `  branch:  ${entry.branch || "(detached)"}`,
    `  repo:    ${entry.cwd}`,
  ];
  if (entry.taskId) lines.push(`  task:    ${entry.taskId}`);
  if (entry.traceId) lines.push(`  trace:   ${entry.traceId}`);
  lines.push(`  message: ${entry.message}`);
  lines.push(
    `  files:   ${entry.files.length ? entry.files.join(", ") : "(none recorded)"}`,
  );
  lines.push("");
  lines.push("Restore into a fresh worktree (non-destructive):");
  lines.push(
    `  git -C ${entry.cwd} worktree add ../recovered-${entry.hash.slice(0, 8)} ${entry.hash}`,
  );
  return lines.join("\n");
}

function prettyList(
  entries: CommitLedgerEntry[],
  all: boolean,
  cwd: string,
): string {
  if (entries.length === 0) {
    return all
      ? "Commit ledger is empty. Agent commits will be recorded here as they happen."
      : `No recorded commits for this repo (${cwd}). Use --all to see every repo.`;
  }
  return [
    `Recorded agent commits${all ? " (all repos)" : ""} — newest first:`,
    ...entries.map((e) => formatRow(e, all)),
    "",
    "Run `oxagen recover <hash>` for restore instructions.",
  ].join("\n");
}

function formatRow(e: CommitLedgerEntry, showRepo: boolean): string {
  const when = e.at.replace("T", " ").slice(0, 16);
  const repo = showRepo ? `  ${e.cwd.split("/").slice(-1)[0]}` : "";
  const task = e.taskId ? `  [${e.taskId}]` : "";
  return `  ${e.hash.slice(0, 8)}  ${when}  ${e.branch || "detached"}${repo}${task}\n      ${e.message}`;
}
