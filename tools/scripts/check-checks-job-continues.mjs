#!/usr/bin/env node
/**
 * The `checks` job in `pipeline.yml` reports every failure in one run (#3428).
 *
 * It used to stop at the first. Turbo ran lint and typecheck without
 * `--continue`, eight checks were chained with `&&`, and every later step ran
 * only if everything before it passed. A branch with two independent problems
 * learned about one per CI cycle. PR #3385 paid three cycles on 2026-09-19 for
 * two ESLint errors and one knip finding.
 *
 * Each property below is a one-word edit away from coming back, and each
 * such edit looks like a tidy-up in review. So this guard holds them:
 *
 *   1. The lint and typecheck turbo call passes `--continue`.
 *   2. No `run:` in the job joins two `pnpm` commands with `&&`.
 *   3. The pnpm-install step has `id: install`.
 *   4. Every step after "Lint and typecheck" runs under
 *      `!cancelled() && steps.install.outcome == 'success'`, except the steps
 *      in EXEMPT_STEPS, which carry their own reason.
 *
 * A text scan, not a YAML parse, for the same reason as
 * check-main-concurrency.mjs: the repo carries no YAML dependency for its
 * guards, and the job's step layout (six-space `- ` items) is stable.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const path = join(repoRoot, ".github", "workflows", "pipeline.yml");

/**
 * Steps after "Lint and typecheck" that may keep the default `success()`.
 *
 * The Linear step runs only on a push to main and is continue-on-error. It
 * files tickets from check:manifest's output, so skipping it after a failed
 * check costs nothing a later run does not redo.
 */
export const EXEMPT_STEPS = new Set(["File Linear tickets for manifest gaps"]);

const CONTINUE_IF =
  /!cancelled\(\)\s*&&\s*steps\.install\.outcome\s*==\s*'success'/;

/** The text of one top-level job under `jobs:`, or null. */
export function jobBlock(yaml, jobName) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * The job's steps, each as { name, uses, id, if, run, text }.
 *
 * `text` holds the step's lines without comment lines, so a comment that
 * quotes the old `&&` chain or a sample `if:` cannot satisfy or trip a check.
 */
export function steps(job) {
  const lines = job.split("\n");
  const at = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (at === -1) return [];
  const out = [];
  let current = null;
  for (const line of lines.slice(at + 1)) {
    if (/^\s*#/.test(line)) continue;
    const item = line.match(/^ {6}- (.*)$/);
    if (item) {
      // Re-indent the item's first key to the step's key column, so a
      // `- run: ...` item reads its body the same way a `run:` line would.
      current = { lines: [`        ${item[1]}`] };
      out.push(current);
    } else if (current && (line.startsWith("        ") || line.trim() === "")) {
      current.lines.push(line);
    }
  }
  return out.map(({ lines: stepLines }) => {
    const text = stepLines.join("\n");
    const key = (name) => {
      const m = text.match(new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "m"));
      return m ? m[1].trim() : null;
    };
    const runAt = stepLines.findIndex((l) => /^\s*run:/.test(l));
    let run = null;
    if (runAt !== -1) {
      const first = stepLines[runAt].replace(/^\s*run:\s*/, "");
      const indent = stepLines[runAt].match(/^\s*/)[0].length;
      const body = [];
      for (const l of stepLines.slice(runAt + 1)) {
        if (l.trim() !== "" && l.match(/^\s*/)[0].length <= indent) break;
        body.push(l.trim());
      }
      // A folded scalar (`>`, `>-`) is one shell line in YAML, so join its
      // lines with spaces; a literal one (`|`) keeps its newlines.
      if (/^>/.test(first)) run = body.join(" ");
      else if (/^\|/.test(first)) run = body.join("\n");
      else run = [first, ...body].join(" ");
    }
    return {
      name: key("name"),
      uses: key("uses"),
      id: key("id"),
      if: key("if"),
      run,
      text,
    };
  });
}

/** Every way the checks job would stop reporting at the first failure. */
export function problems(yaml) {
  const job = jobBlock(yaml, "checks");
  if (!job) return ["pipeline.yml has no `checks` job."];
  const list = steps(job);
  const found = [];

  const lintAt = list.findIndex((s) => s.name === "Lint and typecheck");
  if (lintAt === -1) {
    found.push('The checks job has no "Lint and typecheck" step.');
  } else {
    const run = list[lintAt].run ?? "";
    const call = run
      .split("\n")
      .find((l) => /\bturbo run lint typecheck\b/.test(l));
    if (!call)
      found.push(
        '"Lint and typecheck" no longer runs `turbo run lint typecheck`.',
      );
    else if (!/(^|\s)--continue(\s|$)/.test(call)) {
      found.push(
        '"Lint and typecheck" runs turbo without --continue, so the first failing package hides the rest.',
      );
    }
  }

  for (const s of list) {
    // Join shell continuations first: `pnpm a &&` at the end of one line and
    // `pnpm b` on the next is still a chain, and so is a `\` line break.
    const shell = (s.run ?? "").replace(/\\\n/g, " ").replace(/&&\s*\n/g, "&& ");
    if (/\bpnpm\b[^\n]*&&[^\n]*\bpnpm\b/.test(shell)) {
      found.push(
        `"${s.name ?? s.uses}" chains pnpm commands with &&, so the first failure hides the rest. Use tools/scripts/run-checks.mjs.`,
      );
    }
  }

  const install = list.find((s) => s.uses === "./.github/actions/pnpm-install");
  if (!install) found.push("The checks job has no pnpm-install step.");
  else if (install.id !== "install") {
    found.push(
      "The pnpm-install step needs `id: install`, which the later steps' `if:` reads.",
    );
  }

  if (lintAt !== -1) {
    for (const s of list.slice(lintAt + 1)) {
      const label = s.name ?? s.uses;
      if (EXEMPT_STEPS.has(label)) continue;
      if (!s.if || !CONTINUE_IF.test(s.if)) {
        found.push(
          `"${label}" needs if: \${{ !cancelled() && steps.install.outcome == 'success' }}, so it runs after an earlier check fails and not after a failed install.`,
        );
      }
    }
  }
  return found;
}

// Real paths, not `file://${argv[1]}`: node resolves symlinks in the main
// module's URL but not in argv[1], and a false here would exit 0 having
// checked nothing. run-checks.test.ts proves the symlink case.
const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  const found = problems(readFileSync(path, "utf8"));
  if (found.length > 0) {
    console.error(
      "check-checks-job-continues: the checks job would stop at its first failure (#3428).\n\n" +
        found.map((p) => `  - ${p}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(
    "check-checks-job-continues: the checks job runs every check to the end.",
  );
}
