#!/usr/bin/env node
// SCR corpus drift check (oxagen #1320), extended to the compiled AGENTS.md
// summary of that same corpus (oxagen #2684).
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
// ## The AGENTS.md half (oxagen #2684)
//
// docs/scr/ is the record; every repo also carries a compiled summary of it
// under an `AGENTS.md` "## Standing decisions" heading, and that summary —
// not the record — is what an agent actually holds in context at session
// start. The two can disagree with nobody noticing: oxagen#2673 was exactly
// that, one repo's summary bullet still describing a directive the record had
// already replaced, found only because a human happened to read both.
//
// A byte comparison of AGENTS.md itself would be the wrong tool for this: at
// least SCR-001's compiled bullet deliberately names each repo's own
// toolchain command (`cargo test -p <crate>` vs `pnpm --filter <package>
// test` vs `uv run pytest`), so an exact-bytes check would fail on correct,
// legitimately differing content.
//
// What is checkable without that false positive is narrower: every repo's
// summary carries exactly one bullet per corpus record, and the short title
// naming that record — the text between the id link and the colon, e.g.
// "Tests/builds (inner loop)" — reads the same in every repo even though the
// sentence that follows it may not. `parseStandingDecisionsBullets` extracts
// that title per bullet; `divergeAgentsSummary` compares it against oxagen's
// the same way `diverge` compares corpus blob SHAs, so one report and one
// exit code cover both halves.
//
// ## Exit codes
//
//   0  all five in sync, corpus and summary alike
//   1  drift found (the workflow files an issue)
//   2  the check could not run — auth, network, truncated tree, empty
//      reference. Kept distinct from 1 so a broken check fails loudly instead
//      of reporting a reassuring green, which is the exact defect oxagen #1132
//      fixed in stella-sidecar-nightly.yml.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REFERENCE_REPO = "oxagen";
export const CORPUS_PATH = "docs/scr";
export const AGENTS_MD_PATH = "AGENTS.md";

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
 * Find the blob SHA for the repo-root `AGENTS.md`, or `null` if the repo does
 * not have one. Reads the same tree response `corpusFilesFromTree` reads, so
 * fetching it costs nothing extra.
 */
export function agentsMdBlobSha(treeBody, label = "tree") {
  if (treeBody.truncated) {
    throw new CheckUnavailableError(
      `${label} was truncated by the API; cannot locate ${AGENTS_MD_PATH}`,
    );
  }
  const entry = (treeBody.tree ?? []).find(
    (e) => e.type === "blob" && e.path === AGENTS_MD_PATH,
  );
  return entry ? entry.sha : null;
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

const STANDING_DECISIONS_HEADING = /^##\s+Standing decisions\b.*$/m;
const NEXT_TOP_LEVEL_HEADING = /^##\s+\S/m;

/**
 * Slice out the "## Standing decisions" section of an AGENTS.md, stopping
 * before the next top-level heading (if there is one — today the section runs
 * to end of file in every repo, but nothing here should assume that stays
 * true). Returns `null` when the heading itself is missing.
 */
export function extractStandingDecisionsBlock(markdown) {
  const headingMatch = STANDING_DECISIONS_HEADING.exec(markdown);
  if (!headingMatch) return null;
  const rest = markdown.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = NEXT_TOP_LEVEL_HEADING.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

const BULLET_START = /^-\s/;
const BULLET_PATTERN = /^-\s+\*\*\[(SCR-\d+)\]\(([^)]+)\)\s+—\s+([^]*?):\*\*/;

/**
 * Reassemble a markdown bullet list into one logical string per top-level
 * bullet, undoing the soft-wrap that lets a compiled title span two source
 * lines (`— Tests/builds\n  (inner loop):**`). A blank line ends the current
 * bullet's continuation without starting a new one, matching how the corpus
 * writes this list (one blank line between bullets, none inside one).
 */
function joinWrappedBullets(blockText) {
  const bullets = [];
  let current = null;
  for (const rawLine of blockText.split("\n")) {
    const line = rawLine.trimEnd();
    if (BULLET_START.test(line)) {
      if (current !== null) bullets.push(current);
      current = [line.trim()];
    } else if (line.trim() === "") {
      if (current !== null) bullets.push(current);
      current = null;
    } else if (current !== null) {
      current.push(line.trim());
    }
  }
  if (current !== null) bullets.push(current);
  return bullets.map((lines) => lines.join(" "));
}

/**
 * Parse a "## Standing decisions" block into `{ bullets, unparsed }`.
 *
 * `bullets` maps an SCR id to `{ path, title }`, where `title` is the text
 * between the id link and the colon — the part every repo's compiled summary
 * is expected to state the same way, per the header comment above.
 * `unparsed` holds the (truncated) text of any top-level bullet that did not
 * match the expected `- **[SCR-NNN](path) — Title:**` shape, so a malformed
 * entry is reported rather than silently dropped.
 */
export function parseStandingDecisionsBullets(blockText) {
  const bullets = new Map();
  const unparsed = [];
  for (const bulletText of joinWrappedBullets(blockText)) {
    const match = BULLET_PATTERN.exec(bulletText);
    if (!match) {
      unparsed.push(bulletText.slice(0, 80));
      continue;
    }
    const [, id, path, title] = match;
    bullets.set(id, { path, title: title.trim() });
  }
  return { bullets, unparsed };
}

/**
 * Compare one repo's AGENTS.md summary against the reference's.
 *
 * `candidate` of `null` means the repo has no `AGENTS.md` at all, reported as
 * a single problem rather than one "missing bullet" per SCR — the two are the
 * same underlying fact and only one is worth a reader's attention.
 */
export function divergeAgentsSummary(reference, candidate) {
  if (candidate == null) {
    return [`${AGENTS_MD_PATH}: file not found at repo root`];
  }
  const problems = [];
  for (const [id, ref] of reference.bullets) {
    const theirs = candidate.bullets.get(id);
    if (!theirs) {
      problems.push(`${AGENTS_MD_PATH} summary: missing bullet for ${id}`);
    } else if (theirs.title !== ref.title) {
      problems.push(
        `${AGENTS_MD_PATH} summary: ${id} title differs ` +
          `("${ref.title}" vs "${theirs.title}")`,
      );
    }
  }
  for (const id of candidate.bullets.keys()) {
    if (!reference.bullets.has(id)) {
      problems.push(`${AGENTS_MD_PATH} summary: extra bullet for ${id}`);
    }
  }
  if (candidate.unparsed.length > 0) {
    problems.push(
      `${AGENTS_MD_PATH} summary: ${candidate.unparsed.length} bullet(s) ` +
        "did not match the expected `- **[SCR-NNN](path) — Title:**` shape",
    );
  }
  return problems;
}

/**
 * Render the markdown report and the overall verdict from already-fetched
 * trees. Pure, so the report a human reads in the issue is the same string the
 * tests assert on.
 *
 * @param trees Array of `{ repo, defaultBranch, files, agentsSummary }`,
 *   where `agentsSummary` is `null` (no AGENTS.md) or the
 *   `parseStandingDecisionsBullets` result (possibly empty, when the repo has
 *   an AGENTS.md with no "## Standing decisions" heading).
 */
export function buildReport(trees) {
  const reference = trees.find((t) => t.repo === REFERENCE_REPO);
  if (!reference || reference.files.size === 0) {
    throw new CheckUnavailableError(
      `Reference repo ${REFERENCE_REPO} has no ${CORPUS_PATH}/ files; refusing to ` +
        "declare every other repo divergent on the strength of an empty reference.",
    );
  }
  if (!reference.agentsSummary || reference.agentsSummary.bullets.size === 0) {
    throw new CheckUnavailableError(
      `Reference repo ${REFERENCE_REPO} has no parseable ${AGENTS_MD_PATH} ` +
        '"## Standing decisions" block; refusing to declare every other repo ' +
        "divergent on the strength of an empty reference.",
    );
  }

  const lines = [];
  let drifted = false;
  for (const tree of trees) {
    if (tree.repo === REFERENCE_REPO) continue;
    const problems = [
      ...diverge(reference.files, tree.files),
      ...divergeAgentsSummary(reference.agentsSummary, tree.agentsSummary),
    ];
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
      `(${reference.files.size} files under \`${CORPUS_PATH}/\`, ` +
      `${reference.agentsSummary.bullets.size} AGENTS.md summary bullets)`,
    "",
    ...lines,
  ].join("\n");

  return { drifted, summary };
}

async function fetchBlobText(owner, repo, sha, headers) {
  if (!sha) return null;
  const blobRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`,
    { headers },
  );
  if (!blobRes.ok) {
    throw new CheckUnavailableError(
      `GET blob ${repo}#${sha} -> ${blobRes.status} ${blobRes.statusText}`,
    );
  }
  const { content, encoding } = await blobRes.json();
  if (encoding !== "base64") {
    throw new CheckUnavailableError(
      `Unexpected blob encoding for ${repo}#${sha}: ${encoding}`,
    );
  }
  return Buffer.from(content, "base64").toString("utf8");
}

async function fetchAgentsSummary(owner, repo, sha, headers) {
  const text = await fetchBlobText(owner, repo, sha, headers);
  if (text == null) return null;
  const block = extractStandingDecisionsBlock(text);
  return parseStandingDecisionsBullets(block ?? "");
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
  const agentsMdSha = agentsMdBlobSha(treeBody, label);
  const agentsSummary = await fetchAgentsSummary(
    owner,
    repo,
    agentsMdSha,
    headers,
  );

  return { repo, defaultBranch, files, agentsSummary };
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
