#!/usr/bin/env node
/**
 * Advisory overlap scan for a branch behind main (ADR-110).
 *
 * Missing exact lines are review signals, not a prediction of Git's merge.
 * A clean three-way merge normally preserves changes made only on main.
 * Bad conflict resolutions or later edits can still discard those changes,
 * including after a branch has integrated main. This check does not inspect
 * that earlier history. audit-stale-squash.mjs does so for forensic review.
 *
 * Usage:
 *   node tools/scripts/check-stale-merge-base.mjs
 *   STALE_MERGE_BASE_REF=origin/main STALE_MERGE_BRANCH_REF=HEAD node tools/scripts/check-stale-merge-base.mjs
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GIT_OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

function log(...a) {
  console.log("[check-stale-merge-base]", ...a);
}

/** Split file content into lines, dropping a single trailing empty line. */
export function fileLines(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The lines `main` carries, since the merge base, that the merge-base version
 * did not have: a coarse proxy for "what main added or changed here". A set
 * difference on whole lines, not a real diff, which is cheap, pure, and
 * sufficient for an advisory signal. A line that moved without changing is
 * not "added"; one whose content changed reads as added, since the old line
 * is not the same line as the new one.
 */
export function linesAddedByMain(baseContent, mainContent) {
  const baseLines = new Set(fileLines(baseContent));
  const added = [];
  const seen = new Set();
  for (const line of fileLines(mainContent)) {
    if (baseLines.has(line)) continue;
    if (line.trim() === "") continue; // blank lines carry no content to lose
    if (seen.has(line)) continue;
    seen.add(line);
    added.push(line);
  }
  return added;
}

/**
 * Files touched on both sides since the merge base: the only files a squash
 * merge could possibly take one side's copy of at the other's expense.
 */
export function intersectFiles(branchFiles, mainFiles) {
  const mainSet = new Set(mainFiles);
  return branchFiles.filter((f) => mainSet.has(f)).sort();
}

/**
 * Whether merging this branch risks silently dropping content `main` added
 * to this file since the merge base. The pure decision, so it is testable
 * against string fixtures without a real git checkout.
 *
 * @returns {{ atRisk: boolean, missingLines: string[], reason: string }}
 */
export function fileMergeRisk({ baseContent, mainContent, branchContent }) {
  if (mainContent === branchContent) {
    return {
      atRisk: false,
      missingLines: [],
      reason: "branch's copy already matches main's",
    };
  }
  const added = linesAddedByMain(baseContent, mainContent);
  if (added.length === 0) {
    return {
      atRisk: false,
      missingLines: [],
      reason: "main's change to this file added no new lines",
    };
  }
  const branchLines = new Set(fileLines(branchContent));
  const missing = added.filter((line) => !branchLines.has(line));
  if (missing.length === 0) {
    return {
      atRisk: false,
      missingLines: [],
      reason: "branch's copy already carries every line main added",
    };
  }
  return {
    atRisk: true,
    missingLines: missing,
    reason:
      `branch's copy of this file lacks ${missing.length} line(s) main added ` +
      "since the merge base; inspect the merged result for those changes",
  };
}

// ---------------------------------------------------------------------------
// git I/O, kept separate from the pure decision above
// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { ...GIT_OPTS, cwd }).trim();
}

function changedFiles(fromRef, toRef, cwd) {
  const out = git(
    ["diff", "--name-only", "--diff-filter=ACDMRT", `${fromRef}...${toRef}`],
    cwd,
  );
  return out === "" ? [] : out.split("\n");
}

/** A file's content at a ref, or "" when the file does not exist there. */
function contentAt(ref, path, cwd) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      ...GIT_OPTS,
      cwd,
    });
  } catch {
    return "";
  }
}

/**
 * Runs the check against real refs and returns the report, without printing
 * or exiting. `main()` drives this seam. `cwd` defaults to the process's own
 * working directory; tests pass a temporary repository built to the shape
 * under test.
 */
export function runCheck({ branchRef, mainRef, cwd }) {
  const mergeBase = git(["merge-base", branchRef, mainRef], cwd);
  const mainTip = git(["rev-parse", mainRef], cwd);

  if (mergeBase === mainTip) {
    return { upToDate: true, files: [] };
  }

  const branchFiles = changedFiles(mergeBase, branchRef, cwd);
  const mainFiles = changedFiles(mergeBase, mainRef, cwd);
  const candidates = intersectFiles(branchFiles, mainFiles);

  const files = candidates.map((path) => {
    const baseContent = contentAt(mergeBase, path, cwd);
    const mainContent = contentAt(mainRef, path, cwd);
    const branchContent = contentAt(branchRef, path, cwd);
    const risk = fileMergeRisk({ baseContent, mainContent, branchContent });
    return { path, ...risk };
  });

  return { upToDate: false, mergeBase, mainTip, files };
}

/** Render the report as Markdown for the console and the step summary. */
export function renderReport(report) {
  if (report.upToDate) {
    return (
      "### Stale merge base: up to date\n\n" +
      "This branch contains the latest commit on `main`. This overlap check " +
      "does not inspect earlier integration resolutions or subsequent edits.\n"
    );
  }

  const atRisk = report.files.filter((f) => f.atRisk);
  const lines = [
    "### Stale merge base",
    "",
    `This branch's merge base (\`${report.mergeBase.slice(0, 9)}\`) is behind ` +
      `\`main\`'s current tip (\`${report.mainTip.slice(0, 9)}\`). A squash ` +
      "merge combines both sides from their common base. Inspect the resulting " +
      "content, including integration resolutions. See #3485.",
    "",
  ];

  if (report.files.length === 0) {
    lines.push(
      "No file changed on both sides since the merge base. Nothing here " +
        "overlaps with what main changed. Earlier integrations are outside this check.",
    );
    return lines.join("\n");
  }

  if (atRisk.length === 0) {
    lines.push(
      `${report.files.length} file(s) changed on both sides since the merge ` +
        "base, but each one's branch copy already carries everything main " +
        "added there. This does not establish semantic equivalence.",
    );
    return lines.join("\n");
  }

  lines.push(
    `**${atRisk.length} of ${report.files.length} file(s) changed on both ` +
      "sides look at risk.** Main added content since the merge base that " +
      "this branch's copy does not have:",
    "",
  );
  for (const f of atRisk) {
    lines.push(`- \`${f.path}\`: ${f.reason}`);
    for (const line of f.missingLines.slice(0, 5)) {
      lines.push(
        `    - main has, branch lacks: \`${line.trim().slice(0, 120)}\``,
      );
    }
    if (f.missingLines.length > 5) {
      lines.push(`    - and ${f.missingLines.length - 5} more line(s)`);
    }
  }
  lines.push(
    "",
    "Advisory only, this does not block the merge. Before merging, check " +
      "the merged result for the behavior main added. Integrate current `main` " +
      "and review each resolution before merging.",
  );

  const safe = report.files.filter((f) => !f.atRisk);
  if (safe.length > 0) {
    lines.push(
      "",
      `${safe.length} other file(s) changed on both sides look safe: ` +
        safe.map((f) => `\`${f.path}\``).join(", ") +
        ".",
    );
  }

  return lines.join("\n");
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const branchRef = process.env.STALE_MERGE_BRANCH_REF || "HEAD";
  const mainRef = process.env.STALE_MERGE_BASE_REF || "origin/main";

  let report;
  try {
    report = runCheck({ branchRef, mainRef });
  } catch (err) {
    // Advisory: an environment that cannot answer (shallow clone, missing
    // ref, detached worktree) must not block the merge over its own gap.
    log(
      "could not compute the merge base risk, skipping:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(0);
  }

  const rendered = renderReport(report);
  console.log(rendered);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rendered}\n`);
  }

  const atRiskCount = report.files?.filter((f) => f.atRisk).length ?? 0;
  if (atRiskCount > 0) {
    console.log(
      `::warning title=Stale merge base::${atRiskCount} file(s) changed on ` +
        "both sides since the merge base look at risk of a silent squash " +
        "merge revert. See the step summary.",
    );
  } else {
    log("no at-risk files found.");
  }
  // Always advisory: never fails the build. See the ADR for the reasoning.
}
