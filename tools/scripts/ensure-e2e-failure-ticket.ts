#!/usr/bin/env tsx
/**
 * ensure-e2e-failure-ticket.ts — idempotent Linear ticket for a failing nightly job.
 *
 * When a nightly job fails this script is invoked on-failure. It searches Linear
 * for an existing OPEN tracking ticket for THAT job (identified by a hidden
 * marker in its description). If found, it appends a comment with the failing
 * run URL + commit SHA. If not found, it creates the ticket with that info.
 *
 * The name says e2e because that is the only job it once covered, and the name
 * is kept so the workflow step, the `e2e:failure-ticket` package script and
 * this file stay the single place this behaviour lives. It now serves every
 * nightly job: NIGHTLY_FAILED_JOB names which one, defaulting to "e2e" so the
 * marker it has always searched for is byte-identical.
 *
 * Idempotent: one rolling tracker ticket — never creates duplicates. The ticket
 * stays OPEN until a human closes it, signalling the suite is green again.
 *
 * Usage (CI — called on-failure from .github/workflows/nightly.yml, from both
 * the `e2e` job and each leg of the `full` matrix):
 *   NIGHTLY_FAILED_JOB=typecheck pnpm e2e:failure-ticket
 *
 * Three outcomes, honestly reported (#2555):
 *   1. No LINEAR_API_KEY configured (e.g. a fork) → silent no-op, exit 0.
 *   2. LINEAR_API_KEY is set but the Linear call fails (rejected credential,
 *      GraphQL error, network error) → exit 0 still, BUT the step is no
 *      longer silently green: a `::error::` GitHub Actions annotation is
 *      printed to stdout and a summary is appended to $GITHUB_STEP_SUMMARY
 *      (see `failureReport`/`reportFailure` below), so a reader sees the
 *      miss on the run page without opening the step's log. A rejected
 *      credential (permanent — every future run will fail the same way) is
 *      worded differently from a transient network blip (see
 *      `isPermanentFailure`).
 *   3. Success → ticket filed or updated, exit 0.
 * In every case the script exits 0. The nightly job's own conclusion is
 * decided by the tests, never by this script — a Linear outage must not
 * flip the job red, and a Linear success must not paper over a red suite.
 *
 * Env vars (all provided by GitHub Actions context):
 *   NIGHTLY_FAILED_JOB    — which job failed (e2e, lint, typecheck, …); default e2e
 *   LINEAR_API_KEY        — repo secret (lin_api_… personal key)
 *   LINEAR_PROJECT_ID     — repo var (e.g. oxagen-v2-355ea6b2a3f7)
 *   GITHUB_RUN_ID         — e.g. 14567890123
 *   GITHUB_SHA            — full commit SHA
 *   GITHUB_SERVER_URL     — e.g. https://github.com
 *   GITHUB_REPOSITORY     — e.g. oxagen-ai/oxagen-monorepo
 */

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API_KEY = process.env["LINEAR_API_KEY"];
const PROJECT_ID = process.env["LINEAR_PROJECT_ID"];
const GITHUB_RUN_ID = process.env["GITHUB_RUN_ID"] ?? "unknown";
const GITHUB_SHA = process.env["GITHUB_SHA"] ?? "unknown";
const GITHUB_SERVER_URL =
  process.env["GITHUB_SERVER_URL"] ?? "https://github.com";
const GITHUB_REPOSITORY =
  process.env["GITHUB_REPOSITORY"] ?? "oxagen-ai/oxagen-monorepo";

/** Marker embedded in the tracker description so we can find our own ticket. */
/**
 * Which nightly job failed, and therefore which tracker this run belongs to.
 *
 * The nightly is two jobs, not one: `e2e`, and a `full` matrix of lint,
 * typecheck, test:unit and build. Only `e2e` ever filed a ticket, so a nightly
 * that went red on typecheck — as 2026-09-10 did, on @oxagen/engram — filed
 * nothing, and the issue's title ("nightly test failures don't file a ticket")
 * was only half true (#2555).
 *
 * Each job gets its OWN rolling tracker. One shared ticket would mean a red
 * typecheck appending comments to a ticket about the browser suite, and neither
 * failure legible. Defaulting to "e2e" keeps the existing marker byte-identical,
 * so the tracker this has always looked for is still the one it finds.
 */
const FAILED_JOB = process.env["NIGHTLY_FAILED_JOB"] ?? "e2e";
const MARKER = `<!-- oxagen:${FAILED_JOB}-failure-tracker v1 -->`;
const ENDPOINT = "https://api.linear.app/graphql";

/** Mac Anderson's Linear UUID — assignee for all auto-filed tickets. */
const ASSIGNEE_UUID = "aa47fc28-1b3a-4b45-bb02-d18f2e59c6bb";

/** Labels we want on the tracker (must already exist in the workspace). */
const LABEL_SLUGS = ["testing", "ci", "reliability"] as const;
type LabelSlug = (typeof LABEL_SLUGS)[number];

function log(...args: unknown[]): void {
  console.log(`[${FAILED_JOB}-failure-ticket]`, ...args);
}

/** GitHub Actions run URL for the failing run. */
function runUrl(): string {
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/** Short SHA for display. */
function shortSha(): string {
  return GITHUB_SHA.slice(0, 8);
}

type GqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

async function gql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_KEY as string,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) {
    throw new Error(
      "Linear GraphQL error: " + json.errors.map((e) => e.message).join("; "),
    );
  }
  return json.data as T;
}

/** Resolve team ID, project UUID, viewer ID, and label IDs in one round-trip. */
async function resolveContext(): Promise<{
  teamId: string;
  projectUuid: string;
  labelIds: string[];
}> {
  type CtxData = {
    project: {
      id: string;
      teams: { nodes: Array<{ id: string }> };
    } | null;
    issueLabels: { nodes: Array<{ id: string; name: string }> };
  };

  const ctx = await gql<CtxData>(
    `query($p: String!) {
      project(id: $p) { id teams { nodes { id } } }
      issueLabels(first: 250) { nodes { id name } }
    }`,
    { p: PROJECT_ID },
  );

  if (!ctx.project) {
    throw new Error(`Project not found: ${PROJECT_ID}`);
  }

  const teamNode = ctx.project.teams.nodes[0];
  if (!teamNode) {
    throw new Error(`No team found for project ${PROJECT_ID}`);
  }

  const labelById = (slug: LabelSlug): string | undefined =>
    ctx.issueLabels.nodes.find(
      (l) => l.name.toLowerCase() === slug.toLowerCase(),
    )?.id;

  const labelIds = LABEL_SLUGS.map(labelById).filter((id): id is string =>
    Boolean(id),
  );

  return {
    teamId: teamNode.id,
    projectUuid: ctx.project.id,
    labelIds,
  };
}

type TrackerIssue = {
  id: string;
  identifier: string;
  url: string;
  description: string | null;
  state: { type: string };
};

/** Find our rolling tracker ticket by the hidden marker. */
async function findTracker(): Promise<TrackerIssue | null> {
  type SearchData = {
    issues: {
      nodes: Array<TrackerIssue>;
    };
  };

  const result = await gql<SearchData>(
    `query($q: String!) {
      issues(
        first: 10
        filter: {
          searchableContent: { contains: $q }
          # Linear spells it "canceled" with one L; "cancelled" matches no state
          # type, which would let a canceled tracker keep collecting comments.
          state: { type: { nin: ["canceled", "completed"] } }
        }
      ) {
        nodes { id identifier url description state { type } }
      }
    }`,
    { q: MARKER },
  );

  return (
    result.issues.nodes.find((n) => (n.description ?? "").includes(MARKER)) ??
    null
  );
}

/** Add a comment to an existing tracker ticket with the new failing run. */
async function appendComment(issueId: string): Promise<void> {
  type CommentData = { commentCreate: { success: boolean } };
  const body = [
    `**Nightly ${FAILED_JOB} still failing** — run [${GITHUB_RUN_ID}](${runUrl()}) on commit \`${shortSha()}\`.`,
    "",
    `> Commit: \`${GITHUB_SHA}\``,
    `> Run: ${runUrl()}`,
  ].join("\n");

  await gql<CommentData>(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId, body } },
  );

  log(
    `appended comment to existing tracker (run ${GITHUB_RUN_ID}, sha ${shortSha()}).`,
  );
}

/** Create the rolling tracker ticket. */
async function createTracker(
  teamId: string,
  projectUuid: string,
  labelIds: string[],
): Promise<{ id: string; identifier: string; url: string }> {
  const description = [
    MARKER,
    `## Nightly ${FAILED_JOB} is failing`,
    "",
    "Auto-filed by `tools/scripts/ensure-e2e-failure-ticket.ts` when the nightly",
    `\`${FAILED_JOB}\` job in \`.github/workflows/nightly.yml\` fails.`,
    "",
    "**This ticket stays open as a rolling tracker.** Each new failing run appends",
    "a comment. Close it manually once the suite is green again.",
    "",
    "### First failing run",
    "",
    `- **Run:** [${GITHUB_RUN_ID}](${runUrl()})`,
    `- **Commit:** \`${GITHUB_SHA}\``,
    "",
    "### Acceptance criteria",
    "- [ ] Root cause identified.",
    `- [ ] Nightly ${FAILED_JOB} passes on the next scheduled run.`,
    "- [ ] No regressions introduced by the fix.",
    "",
    "### Risks",
    "- Undetected regressions shipping to prod while the suite is red.",
    "",
    "### Rollback",
    "- Revert the commit(s) identified as the root cause via `git revert`.",
  ].join("\n");

  type CreateData = {
    issueCreate: { issue: { id: string; identifier: string; url: string } };
  };

  const result = await gql<CreateData>(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    {
      input: {
        teamId,
        projectId: projectUuid,
        assigneeId: ASSIGNEE_UUID,
        labelIds,
        // P1 Urgent — a broken nightly suite blocks release confidence.
        priority: 1,
        // S (2) — diagnosis + fix is typically half-day; can grow but starts here.
        estimate: 2,
        title: `Nightly ${FAILED_JOB} failing`,
        description,
      },
    },
  );

  return result.issueCreate.issue;
}

export async function main(): Promise<void> {
  if (!API_KEY) {
    log("no LINEAR_API_KEY — skipping (no-op).");
    return;
  }
  if (!PROJECT_ID) {
    log("no LINEAR_PROJECT_ID — skipping (no-op).");
    return;
  }

  log(`processing failure for run ${GITHUB_RUN_ID} (${shortSha()}).`);

  const tracker = await findTracker();

  if (tracker) {
    // Ticket already exists and is open — append a comment so the timeline
    // shows each failing run without creating duplicates.
    log(`found existing tracker ${tracker.identifier} (${tracker.url}).`);
    await appendComment(tracker.id);
    return;
  }

  // No open tracker — create one.
  const { teamId, projectUuid, labelIds } = await resolveContext();
  const issue = await createTracker(teamId, projectUuid, labelIds);
  log(`created tracker ${issue.identifier} (${issue.url}).`);
}

/**
 * Is this the shape of failure that will happen again tomorrow?
 *
 * A rejected key is permanent: every nightly failure from now on goes
 * unticketed until someone rotates it. A timeout or a 5xx is one bad night. The
 * two want different loudness, and telling them apart is the whole point —
 * before this, both were a line in a log nobody opens (#2555).
 */
export function isPermanentFailure(err: unknown): boolean {
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    message.includes("authentication") ||
    message.includes("not authenticated") ||
    message.includes("unauthorized") ||
    message.includes("invalid api key") ||
    message.includes("forbidden")
  );
}

/**
 * What a reader should see, and where.
 *
 * `::error::` is a GitHub workflow command: it puts an annotation on the run
 * summary page even when the step's own conclusion is success, which is exactly
 * the gap here — the step reported green while its log said FAILED, so the only
 * way to learn no ticket was filed was to open a passing step.
 *
 * The step still exits 0. The e2e job's conclusion belongs to the tests: a
 * Linear outage must not turn a green suite red, and it must not make an
 * already-red one look like a different problem.
 */
export function failureReport(err: unknown): {
  annotation: string;
  summary: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  const permanent = isPermanentFailure(err);
  const headline = permanent
    ? `The nightly ${FAILED_JOB} failure ticket was NOT filed, and will not be filed until someone fixes the Linear key.`
    : `The nightly ${FAILED_JOB} failure ticket was not filed this run.`;
  return {
    annotation: `::error title=${FAILED_JOB} failure ticket not filed::${headline} ${detail}`,
    summary: [
      `### ${FAILED_JOB} failure ticket not filed`,
      "",
      headline,
      "",
      `Reason: \`${detail}\``,
      "",
      permanent
        ? "This is a rejected credential, not a blip. Every red nightly from here on goes untracked. See #2555."
        : "This looks like a one-off. If it repeats, see #2555.",
    ].join("\n"),
  };
}

/** Write the report where a reader will see it without opening a green log. */
export function reportFailure(err: unknown): void {
  const { annotation, summary } = failureReport(err);
  console.error(
    `[${FAILED_JOB}-failure-ticket] FAILED:`,
    err instanceof Error ? err.message : err,
  );
  console.log(annotation);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `${summary}\n`);
    } catch {
      // The annotation above already carries the message; a summary that
      // cannot be written must not become a second failure.
    }
  }
}

// Only run when invoked as a script. Importing this module — which the test
// does — must not fire a Linear call.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    reportFailure(err);
    // Exit 0 intentionally — the job is already red; this is telemetry, and
    // the annotation above is what makes it visible without changing the
    // job's verdict.
    process.exit(0);
  });
}
