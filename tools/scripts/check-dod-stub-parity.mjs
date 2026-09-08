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
// ## Why the pin is compared and the bytes are not
//
// The `dod-check.yml` stubs are not byte-identical and should not be: their
// header comments were written separately and say the same thing differently.
// The pinned ref is the fact worth holding; the prose around it is not.
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

/** Repos that implement the recheck themselves, with why. */
export const RECHECK_EXCEPTIONS = {
  stella:
    "implements the recheck in scripts/dod-recheck.sh with its own tests and make target; the verdict still comes from oxagen's dod-check.yml",
};

/** The oxagen commit a stub's `uses:` line pins, or null. */
export function pinnedRef(source) {
  const m = /dod-check\.yml@([0-9a-f]{7,40})\b/.exec(source ?? "");
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

async function main() {
  const observed = {};
  for (const repo of CALLERS) {
    const check = await api(`/repos/${OWNER}/${repo}/contents/${CHECK}`);
    const recheck = await api(`/repos/${OWNER}/${repo}/contents/${RECHECK}`);
    observed[repo] = {
      checkSource: check
        ? Buffer.from(check.content, "base64").toString("utf8")
        : "",
      recheckSha: recheck?.sha ?? null,
    };
  }

  const problems = divergence(observed);
  if (problems.length === 0) {
    console.log(
      "[dod-stub-parity] every caller pins the same commit, and the recheck stubs match",
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
