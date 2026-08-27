#!/usr/bin/env node
// SCR corpus drift check (oxagen #1320).
//
// docs/scr/ is replicated byte-identically across the five org repos: ADR-038
// chose replication over a shared steering repo and named cross-repo drift as
// the accepted cost. docs/scr/README.md declares that drift "is a bug" — this
// script is what makes that declaration checkable rather than aspirational.
//
// ## Why blob SHAs rather than downloading content
//
// The git tree API returns, for every file, the SHA-1 of its blob — a hash of
// the file's exact bytes. Two files are byte-identical if and only if their
// blob SHAs match. So one tree request per repo settles the whole question,
// where downloading and diffing every record would be more work for less
// certainty. The check also costs the same whether the corpus holds 5 records
// or 500.
//
// ## Why oxagen is the reference
//
// Some copy has to be the reference or "drift" is undefined. ADR-038 lives in
// oxagen and the rollout originated there, so oxagen's tree is canonical by
// construction. That is a naming convention, not a claim that oxagen is more
// correct: a divergence report says "these repos disagree", and the fix is
// always to re-sync all five deliberately, never to blindly overwrite from
// oxagen.
//
// ## Exit codes
//
//   0  all five in sync
//   1  drift found (the workflow files an issue)
//   2  the check could not run — auth, network, truncated tree, empty
//      reference. Kept distinct from 1 so a broken check fails loudly instead
//      of reporting a reassuring green, which is the exact defect oxagen #1132
//      fixed in stella-sidecar-nightly.yml.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REFERENCE_REPO = "oxagen";
export const CORPUS_PATH = "docs/scr";

// The five repos named in ADR-038. A literal rather than an org listing: a new
// org repo should not silently join the corpus contract, and a repo leaving it
// should be a deliberate edit with a reviewer.
export const REPOS = [
  "oxagen",
  "context-graph-protocol",
  "cgp-website",
  "arenabench",
  "stella",
];

/** Raised when the check itself cannot run (exit 2), as opposed to finding drift (exit 1). */
export class CheckUnavailableError extends Error {}

/**
 * Reduce a recursive git tree response to the corpus files it contains, as a
 * map of path -> blob SHA.
 *
 * `truncated` means GitHub capped the response and silently dropped entries.
 * Treating a truncated tree as authoritative would report phantom "missing"
 * drift, so it is a check-broken condition rather than a drift condition.
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
 * Compare one repo's corpus against the reference.
 *
 * Returns human-readable divergence lines; an empty array means in sync. All
 * three divergence kinds are reported rather than short-circuiting on the
 * first, because the issue body should describe the whole gap in one pass.
 */
export function diverge(referenceFiles, candidateFiles) {
  const problems = [];
  for (const [path, sha] of referenceFiles) {
    if (!candidateFiles.has(path)) {
      problems.push(`missing: ${path}`);
    } else if (candidateFiles.get(path) !== sha) {
      const theirs = candidateFiles.get(path);
      problems.push(
        `differs: ${path} (${sha.slice(0, 8)} vs ${theirs.slice(0, 8)})`,
      );
    }
  }
  for (const path of candidateFiles.keys()) {
    if (!referenceFiles.has(path)) problems.push(`extra:   ${path}`);
  }
  return problems;
}

/**
 * Render the markdown report and the overall verdict from already-fetched
 * trees. Pure, so the report a human reads in the issue is the same string the
 * tests assert on.
 *
 * @param trees Array of `{ repo, defaultBranch, files }`.
 */
export function buildReport(trees) {
  const reference = trees.find((t) => t.repo === REFERENCE_REPO);
  if (!reference || reference.files.size === 0) {
    throw new CheckUnavailableError(
      `Reference repo ${REFERENCE_REPO} has no ${CORPUS_PATH}/ files; refusing to ` +
        "declare every other repo divergent on the strength of an empty reference.",
    );
  }

  const lines = [];
  let drifted = false;
  for (const tree of trees) {
    if (tree.repo === REFERENCE_REPO) continue;
    const problems = diverge(reference.files, tree.files);
    if (problems.length === 0) {
      lines.push(`- \`${tree.repo}\` — in sync (${tree.files.size} files)`);
    } else {
      drifted = true;
      lines.push(`- \`${tree.repo}\` — **${problems.length} divergence(s)**`);
      for (const problem of problems) lines.push(`  - ${problem}`);
    }
  }

  const summary = [
    `SCR corpus reference: \`${REFERENCE_REPO}@${reference.defaultBranch}\` ` +
      `(${reference.files.size} files under \`${CORPUS_PATH}/\`)`,
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

  const files = corpusFilesFromTree(
    await treeRes.json(),
    `tree for ${repo}@${defaultBranch}`,
  );
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

// Only run when executed directly, never when imported by the test — mirrors
// check_manifest.mjs so importing the pure exports above has no side effects.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
