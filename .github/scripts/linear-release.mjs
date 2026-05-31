#!/usr/bin/env node
/**
 * linear-release.mjs
 *
 * Creates a Linear Release in the "oxagen-v2" pipeline and associates every
 * OXA-#### issue found in the commit range [PREV_SHA..CURRENT_SHA].
 *
 * Environment variables (all required at runtime):
 *   LINEAR_ACCESS_KEY   — Personal / service API key with write access.
 *   GITHUB_SHA       — Full SHA of the commit being deployed (set by GHA).
 *   PREV_SHA         — SHA of the previous successful deploy (passed explicitly).
 *   RELEASE_NAME     — Human-readable release name (e.g. "2026-05-30 · abc1234").
 *
 * Exit codes:
 *   0 — success or soft-fail (Linear error after logging).
 *   1 — hard failure (missing env vars, git error, unexpected throw).
 *
 * Soft-fail contract: any Linear API error is logged and the process exits 0
 * so a Linear hiccup never blocks a deploy.
 */

import { spawnSync } from "node:child_process";

// ─── Config ─────────────────────────────────────────────────────────────────

/** The "oxagen-v2" release pipeline (continuous, isProduction=true, OXA team). */
const PIPELINE_ID = "5bc1f386-4522-4d36-841a-6e62f10a7989";

/** The single "Released" stage in that pipeline (type=completed). */
const STAGE_ID = "2afc8436-fb63-4971-995c-208094e21ffe";

const LINEAR_API = "https://api.linear.app/graphql";

// ─── Env validation ──────────────────────────────────────────────────────────

/**
 * Reads a required environment variable.
 *
 * @param {string} name
 * @param {{ softFail?: boolean }} [opts]
 *   softFail=true → log and exit 0 (missing key = ops oversight, not a code
 *   bug; the deploy must not be blocked).  Default is hard-fail (exit 1) for
 *   vars that indicate a logic error if absent (GITHUB_SHA, PREV_SHA).
 * @returns {string}
 */
function requireEnv(name, { softFail = false } = {}) {
  const val = process.env[name];
  if (!val) {
    if (softFail) {
      console.warn(`[linear-release] WARN: ${name} is not set — skipping Linear release step.`);
      process.exit(0);
    }
    console.error(`[linear-release] ERROR: Required env var ${name} is not set.`);
    process.exit(1);
  }
  return val;
}

// LINEAR_ACCESS_KEY absent = ops config gap; soft-fail so deploy is never blocked.
const apiKey = requireEnv("LINEAR_ACCESS_KEY", { softFail: true });
// These are injected by GHA itself; absence means a workflow bug (hard-fail).
const currentSha = requireEnv("GITHUB_SHA");
const prevSha = requireEnv("PREV_SHA");
const releaseName = requireEnv("RELEASE_NAME");

// Linear personal API keys (lin_api_…) authenticate with the raw key, while
// OAuth access tokens (lin_access_… / lin_oauth_…) require the "Bearer " scheme.
// LINEAR_ACCESS_KEY is expected to be an OAuth token, so detect by prefix and
// pick the right header — this keeps the script correct for either kind.
const authHeader = apiKey.startsWith("lin_api_") ? apiKey : `Bearer ${apiKey}`;

// ─── GraphQL helper ──────────────────────────────────────────────────────────

/**
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @returns {Promise<Record<string, unknown>>}
 */
async function gql(query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Linear HTTP ${res.status}: ${await res.text()}`);
  }

  /** @type {{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }} */
  const body = /** @type {never} */ (await res.json());

  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `Linear GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  if (!body.data) {
    throw new Error(`Linear returned no data: ${JSON.stringify(body)}`);
  }

  return body.data;
}

// ─── Issue extraction ────────────────────────────────────────────────────────

/**
 * Extract unique OXA-#### identifiers from git log between two SHAs.
 * Returns the raw identifiers like ["OXA-42", "OXA-1418"].
 *
 * @param {string} prev
 * @param {string} current
 * @returns {string[]}
 */
function extractIssueIdentifiers(prev, current) {
  // Use spawnSync with an argument array — no shell involved, so SHAs with
  // unusual characters cannot be interpreted as shell metacharacters.
  // The range "prev..current" is a single git argument; because it comes from
  // env vars (not user-controlled free text), the risk is already minimal, but
  // passing it as a discrete array element (not through exec()) is still the
  // right practice.
  const range = `${prev}..${current}`;
  const result = spawnSync(
    "git",
    ["log", "--oneline", range],
    { encoding: "utf-8" },
  );

  if (result.error) {
    console.error(
      `[linear-release] ERROR: git log failed (prev=${prev.slice(0, 8)}, current=${current.slice(0, 8)}):`,
      result.error.message,
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(
      `[linear-release] ERROR: git log exited ${result.status}: ${result.stderr}`,
    );
    process.exit(1);
  }

  const log = result.stdout;

  const matches = log.match(/OXA-\d+/gi) ?? [];
  const unique = [...new Set(matches.map((m) => m.toUpperCase()))];
  return unique;
}

// ─── Linear issue ID lookup ──────────────────────────────────────────────────

/**
 * Look up Linear internal UUIDs for the given issue identifiers (e.g. "OXA-42").
 * Returns a map from identifier → UUID.  Issues not found are silently skipped.
 *
 * @param {string[]} identifiers
 * @returns {Promise<Map<string, string>>}
 */
async function lookupIssueIds(identifiers) {
  if (identifiers.length === 0) return new Map();

  // Linear's `issues` query supports filtering by identifier.
  // We batch them all in one request with an IN filter.
  const data = await gql(
    `query IssuesByIdentifier($identifiers: [String!]!) {
      issues(filter: { identifier: { in: $identifiers } }) {
        nodes {
          id
          identifier
          title
        }
      }
    }`,
    { identifiers },
  );

  /** @type {{ nodes: Array<{ id: string; identifier: string; title: string }> }} */
  const issues = /** @type {never} */ (data["issues"]);
  const map = new Map();
  for (const issue of issues.nodes) {
    map.set(issue.identifier, issue.id);
    console.log(
      `[linear-release]   Found: ${issue.identifier} — ${issue.title}`,
    );
  }
  return map;
}

// ─── Create release ──────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {string} sha
 * @returns {Promise<string>} Release UUID
 */
async function createRelease(name, sha) {
  const shortSha = sha.slice(0, 8);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const data = await gql(
    `mutation CreateRelease($input: ReleaseCreateInput!) {
      releaseCreate(input: $input) {
        release {
          id
          name
          url
        }
      }
    }`,
    {
      input: {
        name,
        description: `Automated release from CI. Commit: ${sha}`,
        version: `${today}-${shortSha}`,
        commitSha: sha,
        pipelineId: PIPELINE_ID,
        stageId: STAGE_ID,
        startDate: today,
        targetDate: today,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    },
  );

  /** @type {{ release: { id: string; name: string; url: string } }} */
  const payload = /** @type {never} */ (data["releaseCreate"]);
  console.log(
    `[linear-release] Created release: ${payload.release.name} — ${payload.release.url}`,
  );
  return payload.release.id;
}

// ─── Associate issues ────────────────────────────────────────────────────────

/**
 * @param {string} releaseId
 * @param {Map<string, string>} issueIdMap  identifier → UUID
 * @returns {Promise<void>}
 */
async function associateIssues(releaseId, issueIdMap) {
  const entries = [...issueIdMap.entries()];
  if (entries.length === 0) {
    console.log("[linear-release] No OXA issues found in commit range.");
    return;
  }

  // Linear doesn't support a batch mutation for issueToRelease, so we run
  // them sequentially (the number of issues per deploy is small).
  for (const [identifier, issueId] of entries) {
    try {
      await gql(
        `mutation LinkIssueToRelease($input: IssueToReleaseCreateInput!) {
          issueToReleaseCreate(input: $input) {
            issueToRelease {
              id
            }
          }
        }`,
        {
          input: {
            issueId,
            releaseId,
          },
        },
      );
      console.log(`[linear-release]   Linked ${identifier} to release.`);
    } catch (err) {
      // Log but continue — one bad link shouldn't block the rest.
      console.warn(
        `[linear-release]   WARN: Failed to link ${identifier}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[linear-release] Starting — SHA range: ${prevSha.slice(0, 8)}..${currentSha.slice(0, 8)}`);
  console.log(`[linear-release] Release name: "${releaseName}"`);

  // 1. Find OXA issue identifiers in the commit range.
  const identifiers = extractIssueIdentifiers(prevSha, currentSha);
  console.log(
    `[linear-release] Found ${identifiers.length} OXA issue reference(s): ${identifiers.join(", ") || "(none)"}`,
  );

  // 2. Resolve identifiers → Linear UUIDs.
  const issueIdMap = await lookupIssueIds(identifiers);
  console.log(
    `[linear-release] Resolved ${issueIdMap.size}/${identifiers.length} issue(s) in Linear.`,
  );

  // 3. Create the release in the oxagen-v2 pipeline.
  const releaseId = await createRelease(releaseName, currentSha);

  // 4. Associate issues.
  await associateIssues(releaseId, issueIdMap);

  console.log("[linear-release] Done.");
}

main().catch((err) => {
  console.error("[linear-release] FATAL:", err instanceof Error ? err.message : err);
  // Exit 0: soft-fail. A Linear API failure must not block the deploy.
  process.exit(0);
});
