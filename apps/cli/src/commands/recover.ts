/**
 * `oxagen recover` — find and restore agent work from the commit ledger.
 *
 * Every commit an agent makes is recorded (see lib/commit-ledger.ts), so work is
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
 */
import { readLedger, commitExists, type CommitLedgerEntry } from "../lib/commit-ledger.js";

export interface RecoverOptions {
  all?: boolean;
  json?: boolean;
  limit?: number;
}

const out = (s: string): void => void process.stdout.write(s + "\n");
const err = (s: string): void => void process.stderr.write(s + "\n");

export async function handleRecover(hash: string | undefined, opts: RecoverOptions): Promise<void> {
  const cwd = process.cwd();

  if (hash) {
    const entry = readLedger().find((e) => e.hash === hash || e.hash.startsWith(hash));
    if (!entry) {
      err(`No ledger entry for commit ${hash}. Run \`oxagen recover\` to list what's recorded.`);
      process.exitCode = 1;
      return;
    }
    const exists = commitExists(entry.hash, entry.cwd);
    if (opts.json) {
      out(JSON.stringify({ ...entry, commitExists: exists }, null, 2));
      return;
    }
    out(`commit ${entry.hash}${exists ? "" : "  (⚠ object not found in repo — may have been gc'd)"}`);
    out(`  when:    ${entry.at}`);
    out(`  branch:  ${entry.branch || "(detached)"}`);
    out(`  repo:    ${entry.cwd}`);
    if (entry.taskId) out(`  task:    ${entry.taskId}`);
    if (entry.traceId) out(`  trace:   ${entry.traceId}`);
    out(`  message: ${entry.message}`);
    out(`  files:   ${entry.files.length ? entry.files.join(", ") : "(none recorded)"}`);
    out("");
    out("Restore into a fresh worktree (non-destructive):");
    out(`  git -C ${entry.cwd} worktree add ../recovered-${entry.hash.slice(0, 8)} ${entry.hash}`);
    return;
  }

  const entries = readLedger({
    ...(opts.all ? {} : { cwd }),
    limit: opts.limit ?? 30,
  });

  if (opts.json) {
    out(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    out(
      opts.all
        ? "Commit ledger is empty. Agent commits will be recorded here as they happen."
        : `No recorded commits for this repo (${cwd}). Use --all to see every repo.`,
    );
    return;
  }

  out(`Recorded agent commits${opts.all ? " (all repos)" : ""} — newest first:\n`);
  for (const e of entries) {
    out(formatRow(e, opts.all ?? false));
  }
  out(`\nRun \`oxagen recover <hash>\` for restore instructions.`);
}

function formatRow(e: CommitLedgerEntry, showRepo: boolean): string {
  const when = e.at.replace("T", " ").slice(0, 16);
  const repo = showRepo ? `  ${e.cwd.split("/").slice(-1)[0]}` : "";
  const task = e.taskId ? `  [${e.taskId}]` : "";
  return `  ${e.hash.slice(0, 8)}  ${when}  ${e.branch || "detached"}${repo}${task}\n      ${e.message}`;
}
