#!/usr/bin/env node
/**
 * Whether a pipeline.yml run needs the heavy lanes (#4918).
 *
 * The `build`, `unit`, `e2e`, `rls-integration` and `rds-compatibility`
 * lanes, and `test` after them, take most of a pull request's CI minutes. Two
 * kinds of pull request gain nothing from them:
 *
 * - A draft. Agents push a branch many times while they work, and each push
 *   started the full gate, which the next push cancelled 10 to 60 minutes
 *   later. In the week of 2026-09-23 those cancelled runs were 51% of the
 *   pull request minutes. A draft gets `checks` and `atlas-validate`. Marking
 *   it ready (`ready_for_review`) starts the full gate.
 * - A pull request whose every changed file is documentation (`isDocsPath`).
 *   No lane builds, tests or ships those files.
 *
 * Run as a step of the `preflight` job, it writes `heavy=true` or
 * `heavy=false` to $GITHUB_OUTPUT. The lanes carry
 * `needs.preflight.outputs.heavy != 'false'` in their `if:`, so they run
 * unless this script said `false`, and report as skipped when it did.
 *
 * It fails open. Every event other than a pull request gets `true`, and so
 * does a pull request whose file list cannot be read in full. The script
 * exits 0 whatever happens, because the `preflight` job must always succeed
 * (check-main-preflight.mjs): a failed preflight skips `checks` and `test`,
 * and a skipped required check reads as passing.
 */
import { appendFileSync } from "node:fs";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

/** How long one GitHub API call may take before it counts as no answer. */
export const API_TIMEOUT_MS = 10_000;

/** The pull request files endpoint lists at most 3000 files (30 pages of 100). */
export const MAX_FILES = 3000;
const PER_PAGE = 100;

/**
 * Directories under `docs/` that a build or a cached test reads, so a change
 * there is a code change: `@oxagen/docs#build` renders every ADR (turbo.json),
 * and check_manifest and the tools/scripts tests read the capability docs and
 * their JSON schemas.
 */
const DOCS_READ_BY_CODE = ["docs/adr/", "docs/capabilities/"];

/** Agent instruction directories. Their Markdown steers agents, not builds. */
const AGENT_DIRS = [".claude/", ".agents/", ".cursor/"];

/** The one agent directory a cached tools/scripts test reads (tools/scripts/turbo.json). */
const AGENT_DIRS_READ_BY_CODE = [".claude/workflows/"];

/**
 * Markdown read as source: the docs site compiles its content, the marketing
 * site build copies its directory, and `.github/` holds the issue templates
 * the DoD tests read.
 */
const SOURCE_DIRS = ["apps/docs/", "apps/web/", ".github/"];

/** Test fixture directories, whose Markdown a test reads byte for byte. */
const FIXTURE_DIR = /(^|\/)(fixtures?|__fixtures__|tests?|__tests__|testdata)\//;

/** File names that are documentation at any depth outside the directories above. */
const DOC_NAMES = new Set(["README.md", "CLAUDE.md", "AGENTS.md", "CHANGELOG.md"]);

/**
 * Whether a changed path is documentation that no heavy lane reads.
 *
 * Conservative: a path this does not recognise is code. Root `AGENTS.md` is
 * code, because the tools/scripts tests in the `unit` lane read it
 * (shared-cells.test.ts) and tools/scripts/turbo.json declares it an input.
 *
 * @param {string} path a repository-relative path
 * @returns {boolean}
 */
export function isDocsPath(path) {
  if (typeof path !== "string" || path === "" || path.startsWith("/")) return false;
  if (path.split("/").includes("..")) return false;
  if (path === "AGENTS.md") return false;
  if (path.startsWith("docs/")) {
    return !DOCS_READ_BY_CODE.some((dir) => path.startsWith(dir));
  }
  if (!path.endsWith(".md") && !(path.startsWith(".cursor/") && path.endsWith(".mdc"))) {
    return false;
  }
  if (FIXTURE_DIR.test(path)) return false;
  if (SOURCE_DIRS.some((dir) => path.startsWith(dir))) return false;
  if (AGENT_DIRS.some((dir) => path.startsWith(dir))) {
    return !AGENT_DIRS_READ_BY_CODE.some((dir) => path.startsWith(dir));
  }
  // Root-level Markdown (README.md, CHANGELOG.md, CONTRIBUTING.md, ...) and
  // the release notes under releases/.
  if (!path.includes("/")) return true;
  if (/^releases\/[^/]+\.md$/.test(path)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return DOC_NAMES.has(name);
}

/**
 * The decision, separated from I/O so each case is testable.
 *
 * @param {{
 *   eventName: string | undefined,
 *   draft?: boolean,
 *   files?: string[] | null,
 *   error?: string,
 * }} input `files` holds every path the pull request changes, renamed-from
 *   paths included. `error` says the list could not be read in full.
 * @returns {{ heavy: boolean, reason: string, warning?: string }}
 */
export function decideScope({ eventName, draft = false, files = null, error }) {
  if (eventName !== "pull_request") {
    return { heavy: true, reason: `${eventName ?? "an unknown event"} runs every lane` };
  }
  if (draft) {
    return {
      heavy: false,
      reason:
        "this pull request is a draft; it gets checks and atlas-validate, and marking it ready runs every lane",
    };
  }
  if (error || !Array.isArray(files)) {
    return {
      heavy: true,
      reason: `the changed files could not be read in full (${error ?? "no list"}); running every lane`,
      warning: `ci-pr-scope could not read the changed files: ${error ?? "no list"}`,
    };
  }
  if (files.length === 0) {
    return { heavy: true, reason: "the pull request lists no changed files; running every lane" };
  }
  const code = files.filter((file) => !isDocsPath(file));
  if (code.length === 0) {
    return {
      heavy: false,
      reason: `all ${files.length} changed files are documentation; the heavy lanes skip`,
    };
  }
  return {
    heavy: true,
    reason: `${code.length} of ${files.length} changed files are code (first: ${code[0]}); running every lane`,
  };
}

/**
 * Every path a pull request changes, through the pull request files API.
 * A renamed file contributes its old path as well, so moving code into
 * `docs/` is not read as a documentation-only change. Never throws.
 *
 * `expected` is the pull request's `changed_files`. A list that comes back
 * shorter or longer (the endpoint stops at MAX_FILES, and a push can land
 * between the event and this read) is reported as an error, so the caller
 * runs every lane.
 *
 * @param {{
 *   repository: string,
 *   token: string,
 *   number: number,
 *   expected?: number,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} input
 * @returns {Promise<{ files: string[] } | { error: string }>}
 */
export async function readPullRequestFiles({
  repository,
  token,
  number,
  expected,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  if (typeof expected === "number" && expected > MAX_FILES) {
    return { error: `${expected} changed files, more than the ${MAX_FILES} the API lists` };
  }
  /** @type {string[]} */
  const files = [];
  let listed = 0;
  try {
    for (let page = 1; page <= MAX_FILES / PER_PAGE; page += 1) {
      const res = await fetchImpl(
        `https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const batch = await res.json();
      if (!Array.isArray(batch)) return { error: "the files response was not a list" };
      for (const entry of batch) {
        const filename = entry?.filename;
        if (typeof filename !== "string" || filename === "") {
          return { error: "a listed file carried no filename" };
        }
        listed += 1;
        files.push(filename);
        if (typeof entry.previous_filename === "string" && entry.previous_filename !== "") {
          files.push(entry.previous_filename);
        }
      }
      if (batch.length < PER_PAGE) break;
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof expected === "number" && listed !== expected) {
    return { error: `listed ${listed} files where the pull request reports ${expected}` };
  }
  return { files };
}

/**
 * Read the run's environment, decide, and write `heavy` to $GITHUB_OUTPUT.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ heavy: boolean, reason: string, warning?: string }>}
 */
export async function run(env) {
  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName !== "pull_request") return decideScope({ eventName });
  const draft = env.PR_DRAFT === "true";
  if (draft) return decideScope({ eventName, draft });
  const number = Number(env.PR_NUMBER);
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!Number.isInteger(number) || number <= 0 || !repository || !token) {
    return decideScope({
      eventName,
      error: "PR_NUMBER, GITHUB_REPOSITORY and GH_TOKEN must be set",
    });
  }
  const expectedRaw = Number(env.PR_CHANGED_FILES);
  const expected =
    env.PR_CHANGED_FILES && Number.isInteger(expectedRaw) ? expectedRaw : undefined;
  const read = await readPullRequestFiles({ repository, token, number, expected });
  return "error" in read
    ? decideScope({ eventName, error: read.error })
    : decideScope({ eventName, files: read.files });
}

if (isEntrypoint(import.meta.url)) {
  /** @type {{ heavy: boolean, reason: string, warning?: string }} */
  let verdict;
  try {
    verdict = await run(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    verdict = {
      heavy: true,
      reason: `the scope check failed (${message}); running every lane`,
      warning: `ci-pr-scope failed: ${message}`,
    };
  }
  if (verdict.warning) console.log(`::warning::${verdict.warning}`);
  console.log(
    `${verdict.heavy ? "running the heavy lanes" : "::notice::skipping the heavy lanes"}: ${verdict.reason}`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `heavy=${verdict.heavy}\n`);
  }
}
