#!/usr/bin/env tsx
/**
 * ensure-manifest-tickets.ts — keep Linear in sync with capability manifest gaps.
 *
 * `check_manifest.mjs` is warn-only (incomplete capabilities don't fail CI), so
 * the gaps are tracked here instead: this script files a Linear ticket for any
 * capability that is missing a declared layer (unit/e2e/docs/...) — but ONLY
 * when no other open Linear issue already covers that capability's work.
 *
 * Idempotent: it owns a single umbrella "tracker" issue (identified by a hidden
 * marker in its description) with one sub-issue per uncovered capability. Re-runs
 * refresh the tracker and add sub-issues for newly-uncovered capabilities; they
 * never create duplicates. Capabilities already covered by some OTHER ticket
 * (anything mentioning the capability name that isn't part of this tracker) are
 * skipped entirely.
 *
 * Usage:  pnpm check:manifest:tickets        (reads LINEAR_API_KEY, LINEAR_PROJECT_ID)
 *         pnpm check:manifest:tickets --dry-run
 *
 * Safe by design: missing LINEAR_API_KEY → no-op exit 0 (so PRs / local runs
 * without the key don't error). In CI this runs on main only, continue-on-error.
 */
import { execFileSync } from "node:child_process";

const DRY = process.argv.includes("--dry-run");
const API_KEY = process.env.LINEAR_API_KEY;
const PROJECT_ID = process.env.LINEAR_PROJECT_ID;
const MARKER = "<!-- oxagen:manifest-gap-tracker v1 -->";
const ENDPOINT = "https://api.linear.app/graphql";

type Gap = { capability: string; missing: string[] };

function log(...a: unknown[]) {
  console.log("[manifest-tickets]", ...a);
}

async function gql<T = unknown>(
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
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(
      "Linear GraphQL error: " + json.errors.map((e) => e.message).join("; "),
    );
  }
  return json.data as T;
}

/** Read the current manifest gaps via the checker's machine-readable mode. */
function readGaps(): Gap[] {
  const out = execFileSync(
    "node",
    ["tools/scripts/check_manifest.mjs", "--json"],
    {
      encoding: "utf8",
    },
  );
  const parsed = JSON.parse(out) as { gaps?: Gap[] };
  return parsed.gaps ?? [];
}

/** Functional-area label names to attach per capability domain prefix. */
function areaLabelsFor(capability: string): string[] {
  const prefix = capability.split(".")[0] ?? "";
  const map: Record<string, string[]> = {
    billing: ["billing"],
    org: ["iam", "foundations"],
    member: ["iam"],
    iam: ["iam"],
    security: ["security"],
  };
  return map[prefix] ?? [];
}

async function main() {
  if (!API_KEY) {
    log("no LINEAR_API_KEY — skipping (no-op).");
    return;
  }
  if (!PROJECT_ID) {
    log("no LINEAR_PROJECT_ID — skipping (no-op).");
    return;
  }

  const gaps = readGaps();
  if (gaps.length === 0) {
    log("no manifest gaps — nothing to file.");
    return;
  }
  log(`${gaps.length} capabilities have gaps.`);

  // ── Resolve the static IDs we need from the project ──────────────────────
  const ctx = await gql<{
    viewer: { id: string };
    project: {
      id: string;
      name: string;
      teams: { nodes: Array<{ id: string }> };
    } | null;
    issueLabels: { nodes: Array<{ id: string; name: string }> };
  }>(
    `query($p:String!){
      viewer{ id }
      project(id:$p){ id name teams{ nodes{ id } } }
      issueLabels(first:250){ nodes{ id name } }
    }`,
    { p: PROJECT_ID },
  );
  const teamId = ctx.project?.teams.nodes[0]?.id;
  if (!teamId)
    throw new Error(`Could not resolve a team for project ${PROJECT_ID}`);
  // Mutations require the project's canonical UUID; LINEAR_PROJECT_ID may be the
  // slug form (oxagen-v2-<hex>), which `project(id:)` accepts for reads but
  // issueCreate rejects.
  const projectUuid = ctx.project!.id;
  const assigneeId = ctx.viewer.id;
  const labelId = (name: string) =>
    ctx.issueLabels.nodes.find(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    )?.id;

  // ── Find our existing tracker (umbrella) issue, if any, + its sub-issues ──
  const trackerSearch = await gql<{
    issues: {
      nodes: Array<{
        id: string;
        identifier: string;
        url: string;
        description: string | null;
        state: { type: string };
        children: {
          nodes: Array<{ id: string; title: string; state: { type: string } }>;
        };
      }>;
    };
  }>(
    `query($q:String!){
      issues(first:10, filter:{ searchableContent:{ contains:$q } }){
        nodes{ id identifier url description state{ type }
          children{ nodes{ id title state{ type } } } }
      }
    }`,
    { q: MARKER },
  );
  const tracker = trackerSearch.issues.nodes.find((n) =>
    (n.description ?? "").includes(MARKER),
  );
  const trackerChildIds = new Set(
    tracker?.children.nodes.map((c) => c.id) ?? [],
  );
  const trackerChildTitles = new Set(
    tracker?.children.nodes.map((c) => c.title) ?? [],
  );

  // ── Determine which capabilities are NOT already covered by another ticket ─
  const uncovered: Gap[] = [];
  for (const gap of gaps) {
    const found = await gql<{
      issues: {
        nodes: Array<{
          id: string;
          state: { type: string };
          parent: { id: string } | null;
          description: string | null;
        }>;
      };
    }>(
      `query($q:String!){
        issues(first:20, filter:{ searchableContent:{ contains:$q } }){
          nodes{ id state{ type } parent{ id } description }
        }
      }`,
      { q: gap.capability },
    );
    const external = found.issues.nodes.filter(
      (n) =>
        n.state.type !== "canceled" &&
        n.id !== tracker?.id &&
        !trackerChildIds.has(n.id) &&
        n.parent?.id !== tracker?.id &&
        !(n.description ?? "").includes(MARKER),
    );
    if (external.length > 0) {
      log(
        `skip ${gap.capability} — covered by ${external.length} existing ticket(s).`,
      );
    } else {
      uncovered.push(gap);
    }
  }

  if (uncovered.length === 0) {
    log(
      "all gapped capabilities are already covered by existing tickets — nothing to file.",
    );
    return;
  }

  // ── Compose the tracker description ──────────────────────────────────────
  const rows = uncovered
    .map((g) => `| \`${g.capability}\` | ${g.missing.join(", ")} |`)
    .join("\n");
  const description = [
    MARKER,
    "## Capability manifest gaps — complete the missing layers",
    "",
    "Auto-filed by `tools/scripts/ensure-manifest-tickets.ts`. Each capability below",
    "declares a layer (`unit`/`e2e`/`docs`/…) that has no file on disk. `check:manifest`",
    "is warn-only, so these don't block CI — they're tracked here until completed.",
    "",
    "| Capability | Missing layer(s) |",
    "| --- | --- |",
    rows,
    "",
    "### Acceptance criteria",
    "- [ ] Every capability above has a real file for each missing layer (no stubs).",
    "- [ ] `pnpm check:manifest --strict` exits 0.",
    "",
    "Layer→path: `unit` = `packages/oxagen/src/contracts/<cap>.test.ts`, " +
      "`e2e` = `apps/app/e2e/<cap-slug>.spec.ts`, `docs` = `docs/capabilities/<cap>.md`.",
  ].join("\n");

  if (DRY) {
    log(
      `DRY-RUN: would ${tracker ? "update" : "create"} tracker with ${uncovered.length} sub-issue(s):`,
    );
    uncovered.forEach((g) =>
      log(`  - ${g.capability} (missing: ${g.missing.join(", ")})`),
    );
    return;
  }

  // Union of labels across the uncovered capabilities, always incl. agent-created + tech-debt.
  const labelNames = new Set<string>(["agent-created", "tech-debt"]);
  uncovered.forEach((g) =>
    areaLabelsFor(g.capability).forEach((n) => labelNames.add(n)),
  );
  const labelIds = [...labelNames]
    .map(labelId)
    .filter((x): x is string => Boolean(x));

  // ── Create or update the umbrella tracker ────────────────────────────────
  let trackerId = tracker?.id;
  if (tracker) {
    await gql(
      `mutation($id:String!,$desc:String!){ issueUpdate(id:$id, input:{ description:$desc }){ success } }`,
      { id: tracker.id, desc: description },
    );
    log(`updated tracker ${tracker.identifier} (${tracker.url}).`);
  } else {
    const created = await gql<{
      issueCreate: { issue: { id: string; identifier: string; url: string } };
    }>(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }`,
      {
        input: {
          teamId,
          projectId: projectUuid,
          assigneeId,
          labelIds,
          priority: 2, // High — billing/IAM completeness is audit-adjacent.
          estimate: 5, // L — multiple capabilities, test+docs across packages.
          title: "Complete missing capability manifest layers",
          description,
        },
      },
    );
    trackerId = created.issueCreate.issue.id;
    log(
      `created tracker ${created.issueCreate.issue.identifier} (${created.issueCreate.issue.url}).`,
    );
  }

  // ── Ensure one sub-issue per uncovered capability ────────────────────────
  for (const g of uncovered) {
    const title = `Complete layers for ${g.capability}: ${g.missing.join(", ")}`;
    const titlePrefix = `Complete layers for ${g.capability}`;
    const already = [...trackerChildTitles].some((t) =>
      t.startsWith(titlePrefix),
    );
    if (already) {
      log(`sub-issue for ${g.capability} already exists — skipping.`);
      continue;
    }
    const subLabels = [
      "agent-created",
      "tech-debt",
      ...areaLabelsFor(g.capability),
    ]
      .map(labelId)
      .filter((x): x is string => Boolean(x));
    const sub = await gql<{ issueCreate: { issue: { identifier: string } } }>(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ identifier } } }`,
      {
        input: {
          teamId,
          projectId: projectUuid,
          parentId: trackerId,
          assigneeId,
          labelIds: subLabels,
          priority: 2,
          estimate: 2, // S — one capability's missing layers.
          title,
          description: [
            `Add the missing layer(s) for \`${g.capability}\`: **${g.missing.join(", ")}**.`,
            "",
            "No stubs — real assertions / real docs. See parent for layer→path mapping.",
          ].join("\n"),
        },
      },
    );
    log(`  + sub-issue ${sub.issueCreate.issue.identifier} — ${g.capability}`);
  }

  log("done.");
}

main().catch((err) => {
  console.error(
    "[manifest-tickets] FAILED:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
