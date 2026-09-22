#!/usr/bin/env node
// docs/scr/ absence check (oxagen #1320, revised by ADR-137).
//
// ADR-038 replicated docs/scr/ across five org repos and accepted drift as
// the cost. ADR-137 retired that corpus. Standing decisions are context
// records in oxagen's .oxagen/rules/, and a connected repository is steered
// from the workspace. A file under docs/scr/ in any of the five repos is the
// old copy coming back.
//
// The DoD caller stubs are a different replication and stay on
// check-dod-stub-parity.mjs. This script does not look at AGENTS.md.
//
// ## Exit codes
//
//   0  none of the five repos has a file under docs/scr/
//   1  at least one repo still has one
//   2  the check could not run. Kept distinct from 1 so a broken check fails
//      loudly instead of reporting a reassuring green (oxagen #1132).

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REFERENCE_REPO = "oxagen";
export const CORPUS_PATH = "docs/scr";

// The five repos named in ADR-038. A literal rather than an org listing: a new
// org repo should not silently join this contract, and a repo leaving it
// should be a deliberate edit with a reviewer.
export const REPOS = [
  "oxagen",
  "context-graph-protocol",
  "cgp-website",
  "arenabench",
  "stella",
];

/** Raised when the check itself cannot run (exit 2), as opposed to finding a leftover corpus (exit 1). */
export class CheckUnavailableError extends Error {}

/**
 * Reduce a recursive git tree response to the docs/scr files it contains, as a
 * map of path -> blob SHA.
 *
 * `truncated` means GitHub capped the response and silently dropped entries.
 * Treating a truncated tree as empty would report a clean repo that is not,
 * so it is a check-broken condition rather than a pass.
 */
export function corpusFilesFromTree(treeBody, label = "tree") {
  if (treeBody.truncated) {
    throw new CheckUnavailableError(
      `${label} was truncated by the API; cannot compare reliably`,
    );
  }
  const files = new Map();
  for (const entry of treeBody.tree ?? []) {
    if (entry.type === "blob" && entry.path.startsWith(`${CORPUS_PATH}/`)) {
      files.set(entry.path, entry.sha);
    }
  }
  return files;
}

/**
 * Render the report. A repo with no docs/scr files is the expected state.
 * Any file under that path, in any of the five repos, is a failure.
 *
 * @param trees Array of `{ repo, defaultBranch, files }`.
 */
export function buildReport(trees) {
  const lines = [];
  let drifted = false;
  for (const tree of trees) {
    const paths = [...tree.files.keys()].sort();
    if (paths.length === 0) {
      lines.push(`- \`${tree.repo}\`: no ${CORPUS_PATH}/ files`);
    } else {
      drifted = true;
      lines.push(
        `- \`${tree.repo}\`: **${paths.length} ${CORPUS_PATH}/ file(s) still present**`,
      );
      for (const path of paths) lines.push(`  - ${path}`);
    }
  }

  const summary = [
    "Standing decisions are context records in oxagen's `.oxagen/rules/` (ADR-137). " +
      `\`${CORPUS_PATH}/\` is not copied.`,
    "",
    ...lines,
  ].join("\n");

  return { drifted, summary };
}

async function fetchCorpusTree(owner, repo, token) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "scr-corpus-check",
  };

  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers,
  });
  if (!repoRes.ok) {
    throw new CheckUnavailableError(
      `GET /repos/${owner}/${repo} -> ${repoRes.status} ${repoRes.statusText}`,
    );
  }
  const { default_branch: defaultBranch } = await repoRes.json();

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
    { headers },
  );
  if (!treeRes.ok) {
    throw new CheckUnavailableError(
      `GET tree ${repo}@${defaultBranch} -> ${treeRes.status} ${treeRes.statusText}`,
    );
  }

  const treeBody = await treeRes.json();
  const label = `tree for ${repo}@${defaultBranch}`;
  const files = corpusFilesFromTree(treeBody, label);
  return { repo, defaultBranch, files };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error(
      "GITHUB_TOKEN is required (needs read access to all five org repos).",
    );
    process.exit(2);
  }
  const owner = process.env.SCR_OWNER ?? "macanderson";

  let result;
  try {
    const trees = [];
    for (const repo of REPOS) {
      trees.push(await fetchCorpusTree(owner, repo, token));
    }
    result = buildReport(trees);
  } catch (error) {
    if (error instanceof CheckUnavailableError) {
      console.error(`SCR corpus check could not run: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  console.log(result.summary);

  // The workflow renders the issue body from these outputs rather than
  // re-deriving a verdict, so the issue text and the exit code can never
  // disagree about what was found.
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = "scr-report-delimiter";
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `drifted=${result.drifted}\nreport<<${delimiter}\n${result.summary}\n${delimiter}\n`,
    );
  }

  process.exit(result.drifted ? 1 : 0);
}

// Only run when executed directly, never when imported by the test.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
