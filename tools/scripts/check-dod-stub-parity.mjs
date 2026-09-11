#!/usr/bin/env node
// Caller-stub drift check for the two DoD workflows (oxagen #2661).
//
// ADR-039 keeps one implementation here and gives the four caller repos a
// ~12-line stub each. A stub is small enough that nobody reviews it twice and
// large enough to drift, and two of its facts matter:
//
//   - `dod-check.yml` must pin the SAME oxagen commit in all four. ADR-045
//     chose a commit SHA over `@main` so this repository cannot change a
//     required check elsewhere without a commit there; the cost is a re-pin
//     per repo, and the failure mode is paying it in three of four. That
//     happened: `2dd72c99` predated the `closes-nothing` label, so the label
//     existed in four repos and did nothing in any of them (#2551).
//
//   - `dod-recheck.yml` must be byte-identical across the repos that carry the
//     stub, since there is nothing in it to legitimately differ.
//
//   - `dod-close-guard.yml` must pin a commit too, and all four must resolve to
//     the same file. This is the stub that carries `issues: write`, so it is the
//     one where a moving ref hands another repository the ability to change what
//     closes an issue here with no commit to review — which is #1336. Three of
//     the four sat on `@main` until 2026-09-11 and nothing here noticed, because
//     this script only ever looked at the other two workflows.
//
// ## Why the pin is compared and the bytes are not
//
// The `dod-check.yml` stubs are not byte-identical and should not be: their
// header comments were written separately and say the same thing differently.
// The pinned ref is the fact worth holding; the prose around it is not.
//
// ## Why the close guard compares the resolved file and not the pinned ref
//
// The same rule as `dod-check.yml` would be wrong here. stella pins
// `2b61b052` and the other three pin `84fe021b`, and both resolve to the same
// bytes — the second commit did not change the file. Comparing the ref strings
// would report drift where there is none. Comparing what each ref RESOLVES to
// asks the question the rule is actually for: are all four running the same
// close guard? That still catches a partial re-pin, because a re-pin that
// changes the file in three repos and not the fourth changes the blob in three
// and not the fourth.
//
// ## The declared exception
//
// `macanderson/stella` implements the recheck itself, in
// `scripts/dod-recheck.sh`, with its own tests and `make` target, and its
// AGENTS.md documents it. That is not the drift ADR-039 exists to stop: the
// VERDICT still comes from one implementation here — stella's file only
// subscribes to its own issue edits and asks for a re-run, which is a per-repo
// event subscription rather than a second copy of the rule.
//
// It is named here rather than left to be rediscovered, and naming it is what
// makes a FIFTH shape fail instead of joining it.

const OWNER = "macanderson";
const CALLERS = [
  "stella",
  "arenabench",
  "cgp-website",
  "context-graph-protocol",
];
const CHECK = ".github/workflows/dod-check.yml";
const RECHECK = ".github/workflows/dod-recheck.yml";
const CLOSE_GUARD = ".github/workflows/dod-close-guard.yml";

/** Repos that implement the recheck themselves, with why. */
export const RECHECK_EXCEPTIONS = {
  stella:
    "implements the recheck in scripts/dod-recheck.sh with its own tests and make target; the verdict still comes from oxagen's dod-check.yml",
};

/**
 * The oxagen commit a stub's `uses:` line pins, or null.
 *
 * `workflow` names which stub is being read, because a repo carries more than
 * one and a regex that matched any of them would read the wrong line.
 */
export function pinnedRef(source, workflow = "dod-check.yml") {
  const escaped = workflow.replace(/\./g, "\\.");
  const m = new RegExp(`${escaped}@([0-9a-f]{7,40})\\b`).exec(source ?? "");
  return m ? m[1] : null;
}

/**
 * What is wrong, given each caller's stub source and recheck blob sha.
 *
 * `recheckSha` is git's blob SHA — the hash of the file's exact bytes — so two
 * stubs are identical exactly when it matches, with no content to download.
 */
export function divergence(observed) {
  const problems = [];

  const pins = new Map();
  for (const [repo, facts] of Object.entries(observed)) {
    const ref = pinnedRef(facts.checkSource);
    if (!ref) {
      problems.push(
        `${repo}: ${CHECK} pins no oxagen commit — a moving ref or a missing uses: line`,
      );
      continue;
    }
    pins.set(repo, ref);
  }
  const distinct = new Set(pins.values());
  if (distinct.size > 1) {
    const listed = [...pins]
      .map(([r, p]) => `${r}=${p.slice(0, 8)}`)
      .join(", ");
    problems.push(
      `${CHECK} pins disagree: ${listed}. Re-pin every caller in one pass — a partial re-pin is how a fix reaches some repos and not others.`,
    );
  }

  const shas = new Map();
  for (const [repo, facts] of Object.entries(observed)) {
    if (repo in RECHECK_EXCEPTIONS) continue;
    if (!facts.recheckSha) {
      problems.push(
        `${repo}: ${RECHECK} is missing — issue edits there re-run nothing`,
      );
      continue;
    }
    shas.set(repo, facts.recheckSha);
  }
  if (new Set(shas.values()).size > 1) {
    problems.push(
      `${RECHECK} differs between ${[...shas.keys()].join(", ")}. There is nothing in that stub that may legitimately differ; copy one over the others.`,
    );
  }

  const guardBlobs = new Map();
  for (const [repo, facts] of Object.entries(observed)) {
    const source = facts.closeGuardSource ?? "";
    if (source === "") {
      problems.push(
        `${repo}: ${CLOSE_GUARD} is missing — nothing there holds an issue closed against its DoD`,
      );
      continue;
    }
    if (!pinnedRef(source, "dod-close-guard.yml")) {
      problems.push(
        `${repo}: ${CLOSE_GUARD} pins no oxagen commit — a moving ref on the one stub that carries issues: write (#1336)`,
      );
      continue;
    }
    // A pin that cannot be resolved is reported by the caller as null rather
    // than thrown, so a deleted commit reads as drift instead of taking the
    // whole check down with it.
    if (!facts.closeGuardBlob) {
      problems.push(
        `${repo}: ${CLOSE_GUARD} pins a commit that no longer resolves — the workflow it names is gone`,
      );
      continue;
    }
    guardBlobs.set(repo, facts.closeGuardBlob);
  }
  if (new Set(guardBlobs.values()).size > 1) {
    const listed = [...guardBlobs]
      .map(([r, b]) => `${r}=${b.slice(0, 8)}`)
      .join(", ");
    problems.push(
      `${CLOSE_GUARD} pins resolve to different files: ${listed}. The pins may differ; what they point at may not.`,
    );
  }

  return problems;
}

async function api(path) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/**
 * The blob sha of the close guard AS THE CALLER PINS IT, or null.
 *
 * Reading the file at the pinned ref rather than at oxagen's `main` is the
 * whole point: what a caller runs is the version it named, and that is what has
 * to agree between the four. A ref that no longer resolves returns null so the
 * caller can call it drift, rather than throwing into the fail-open path and
 * reporting nothing at all.
 */
async function resolveCloseGuardBlob(guardSource) {
  const ref = pinnedRef(guardSource, "dod-close-guard.yml");
  if (!ref) return null;
  const at = await api(
    `/repos/${OWNER}/oxagen/contents/${CLOSE_GUARD}?ref=${ref}`,
  );
  return at?.sha ?? null;
}

async function main() {
  const observed = {};
  for (const repo of CALLERS) {
    const check = await api(`/repos/${OWNER}/${repo}/contents/${CHECK}`);
    const recheck = await api(`/repos/${OWNER}/${repo}/contents/${RECHECK}`);
    const guard = await api(`/repos/${OWNER}/${repo}/contents/${CLOSE_GUARD}`);
    const guardSource = guard
      ? Buffer.from(guard.content, "base64").toString("utf8")
      : "";
    observed[repo] = {
      checkSource: check
        ? Buffer.from(check.content, "base64").toString("utf8")
        : "",
      recheckSha: recheck?.sha ?? null,
      closeGuardSource: guardSource,
      closeGuardBlob: await resolveCloseGuardBlob(guardSource),
    };
  }

  const problems = divergence(observed);
  if (problems.length === 0) {
    console.log(
      "[dod-stub-parity] every caller pins the same commit, the recheck stubs match, and every close guard resolves to one file",
    );
    for (const [repo, why] of Object.entries(RECHECK_EXCEPTIONS)) {
      console.log(`  (${repo} implements the recheck itself: ${why})`);
    }
    return;
  }
  console.error("[dod-stub-parity] caller stubs have drifted:\n");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err) => {
    // Fails open: this reads four other repositories over the network, and a
    // rate limit or an outage must not be what blocks a merge here.
    console.log(
      `[dod-stub-parity] UNAVAILABLE — THIS CHECK DID NOT RUN: ${err.message}`,
    );
    process.exit(0);
  });
}
