#!/usr/bin/env tsx
/**
 * ensure-e2e-failure-ticket.ts — idempotent Linear ticket for a failing nightly e2e job.
 *
 * When the nightly e2e job fails this script is invoked on-failure. It searches
 * Linear for an existing OPEN "nightly e2e failing" tracking ticket (identified by a
 * hidden marker in its description). If found, it appends a comment with the failing
 * run URL + commit SHA. If not found, it creates the ticket with that info.
 *
 * Idempotent: one rolling tracker ticket — never creates duplicates. The ticket
 * stays OPEN until a human closes it, signalling the suite is green again.
 *
 * Usage (CI — called on-failure from .github/workflows/nightly.yml):
 *   pnpm e2e:failure-ticket
 *
 * Safe by design: missing LINEAR_API_KEY → no-op exit 0 so a misconfigured
 * runner never breaks an already-failing job further.
 *
 * Env vars (all provided by GitHub Actions context):
 *   LINEAR_API_KEY        — repo secret (lin_api_… personal key)
 *   LINEAR_PROJECT_ID     — repo var (e.g. oxagen-v2-355ea6b2a3f7)
 *   GITHUB_RUN_ID         — e.g. 14567890123
 *   GITHUB_SHA            — full commit SHA
 *   GITHUB_SERVER_URL     — e.g. https://github.com
 *   GITHUB_REPOSITORY     — e.g. oxagen-ai/oxagen-monorepo
 */

const API_KEY = process.env["LINEAR_API_KEY"];
const PROJECT_ID = process.env["LINEAR_PROJECT_ID"];
const GITHUB_RUN_ID = process.env["GITHUB_RUN_ID"] ?? "unknown";
const GITHUB_SHA = process.env["GITHUB_SHA"] ?? "unknown";
const GITHUB_SERVER_URL =
  process.env["GITHUB_SERVER_URL"] ?? "https://github.com";
const GITHUB_REPOSITORY =
  process.env["GITHUB_REPOSITORY"] ?? "oxagen-ai/oxagen-monorepo";

/** Marker embedded in the tracker description so we can find our own ticket. */
const MARKER = "<!-- oxagen:e2e-failure-tracker v1 -->";
const ENDPOINT = "https://api.linear.app/graphql";

/** Mac Anderson's Linear UUID — assignee for all auto-filed tickets. */
const ASSIGNEE_UUID = "aa47fc28-1b3a-4b45-bb02-d18f2e59c6bb";

/** Labels we want on the tracker (must already exist in the workspace). */
const LABEL_SLUGS = ["testing", "ci", "reliability"] as const;
type LabelSlug = (typeof LABEL_SLUGS)[number];

function log(...args: unknown[]): void {
  console.log("[e2e-failure-ticket]", ...args);
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
    `**Nightly e2e still failing** — run [${GITHUB_RUN_ID}](${runUrl()}) on commit \`${shortSha()}\`.`,
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
    "## Nightly e2e suite is failing",
    "",
    "Auto-filed by `tools/scripts/ensure-e2e-failure-ticket.ts` when the nightly",
    "`e2e` job in `.github/workflows/nightly.yml` fails.",
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
    "- [ ] Nightly e2e suite passes on the next scheduled run.",
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
        title: "Nightly e2e suite failing",
        description,
      },
    },
  );

  return result.issueCreate.issue;
}

async function main(): Promise<void> {
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

main().catch((err: unknown) => {
  // Best-effort: log but do not re-throw. The e2e job is already failing;
  // we must not compound that with a ticket-script error surfaced to CI.
  console.error(
    "[e2e-failure-ticket] FAILED:",
    err instanceof Error ? err.message : err,
  );
  // Exit 0 intentionally — the job is already red; this is telemetry.
  process.exit(0);
});
