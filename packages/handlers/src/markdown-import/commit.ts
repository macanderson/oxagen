// audit-exempt: opening the steering PR publishes nothing (nothing steers until it merges); the kernel's capability.invoke_* audit records the call, and the merge records its own events.
//
// markdown-import/commit.ts: commit_markdown_import (memory-collection spec,
// Bulk import; discussions spec, Markdown import).
//
// Flow:
//   1. Refuse what the PR could not hold: a conflict nobody chose for, a
//      policy the early checks failed, two rows with one lineage, or two
//      files at one path.
//   2. Render each record row marked add (render.ts). A record whose lineage
//      is published is written where it lives now, so the import revises it.
//   3. Take the first free branch of the day: steering/import-<date>, then
//      -2, -3, and so on.
//   4. Open one steering PR with every file through the steering PR opener
//      (opener.ts). It runs the steering checks on the new head and reports
//      them as the "Oxagen steering" check.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { steeringMarkdownImportCommit } from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import type {
  MarkdownImportPolicy,
  MarkdownImportRecord,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { assertContractRole } from "../lib/capability-role-guard";
import { markdownImportBranch } from "../steering-repo/stamp";
import type { ToolsPullRequestFile } from "../tools.pr.open";
import type { MarkdownImportDeps } from "./deps";
import { importRecordPath, renderImportRecord } from "./render";

/** The most branch numbers one day takes before the import gives up. */
const BRANCHES_PER_DAY_MAX = 50;

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/** Where a row came from, for a message: "CLAUDE.md line 12". */
function sourceOf(row: Pick<MarkdownImportRecord, "file" | "line">): string {
  return `${row.file} line ${row.line}`;
}

/** The PR body: what the import holds, file by file, and what was left out. */
export function importPullRequestBody(args: {
  records: readonly { row: MarkdownImportRecord; path: string }[];
  policies: readonly MarkdownImportPolicy[];
  skipped: number;
}): string {
  const lines: string[] = [
    "This steering PR imports Markdown files into steering records and Cedar policies. Nothing in it steers an agent until it merges.",
    "",
  ];
  if (args.records.length > 0) {
    lines.push("## Records", "");
    lines.push("| Path | Kind | Force | Source |", "|---|---|---|---|");
    for (const { row, path } of args.records) {
      const effect = row.effect ? ` (${row.effect})` : "";
      lines.push(`| \`${path}\` | ${row.kind}${effect} | ${row.force} | ${sourceOf(row)} |`);
    }
    lines.push("");
  }
  if (args.policies.length > 0) {
    lines.push("## Policies", "");
    lines.push("| Path | Statements | Source |", "|---|---|---|");
    for (const policy of args.policies) {
      const ids = policy.statements.map((s) => `\`${s.id}\``).join(", ");
      const replaces = policy.replaces ? " Replaces the file at this path." : "";
      lines.push(`| \`${policy.path}\` | ${ids} | ${policy.file}.${replaces} |`);
    }
    lines.push("");
  }
  if (args.skipped > 0) {
    lines.push(
      `${args.skipped} ${args.skipped === 1 ? "row was" : "rows were"} marked skip and left out.`,
      "",
    );
  }
  lines.push(
    "Each record carries `origin: user` and `provenance.source: import`, with the file and line it came from. Oxagen writes each record's `id` and `hash` when the PR merges.",
  );
  return `${lines.join("\n")}\n`;
}

export function createCommitMarkdownImportHandler(
  deps: MarkdownImportDeps,
): CapabilityHandler<typeof steeringMarkdownImportCommit> {
  return async (input, ctx) => {
    await assertContractRole(steeringMarkdownImportCommit, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const records = input.records;
    const policies = input.policies;

    const undecided = records.find((row) => row.action === null);
    if (undecided) {
      throw refuse(
        "conflict_unresolved",
        `${sourceOf(undecided)} (${undecided.lineage}) conflicts with ${undecided.conflict?.lineage ?? "another record"}. Mark it add or skip before you commit.`,
      );
    }
    const broken = policies.find(
      (policy) => policy.action === "add" && policy.issues.length > 0,
    );
    if (broken) {
      throw refuse(
        "policy_invalid",
        `${broken.file} cannot become ${broken.path}: ${broken.issues[0]?.message ?? "the early checks failed"}. Fix the file and parse it again, or import it as a record.`,
      );
    }

    const keptRecords = records.filter((row) => row.action === "add");
    const keptPolicies = policies.filter((policy) => policy.action === "add");
    const skipped =
      records.length - keptRecords.length + (policies.length - keptPolicies.length);
    if (keptRecords.length + keptPolicies.length === 0) {
      throw refuse(
        "nothing_to_import",
        "Every row is marked skip, so there is nothing to put in a steering PR. Mark at least one record or policy add.",
      );
    }

    const lineages = new Map<string, MarkdownImportRecord>();
    for (const row of keptRecords) {
      const other = lineages.get(row.lineage);
      if (other) {
        throw refuse(
          "duplicate_lineage",
          `${sourceOf(other)} and ${sourceOf(row)} both have the lineage ${row.lineage}. Give one of them another lineage.`,
        );
      }
      lineages.set(row.lineage, row);
    }

    const published = await deps.publishedRecords(scope);
    const heldPath = new Map(published.map((record) => [record.lineage, record.path]));
    const files: ToolsPullRequestFile[] = [];
    const placed: { row: MarkdownImportRecord; path: string }[] = [];
    const owner = new Map<string, string>();
    const place = (path: string, from: string) => {
      const other = owner.get(path);
      if (other !== undefined) {
        throw refuse(
          "duplicate_path",
          `${other} and ${from} both become ${path}. Rename one of them.`,
        );
      }
      owner.set(path, from);
    };
    for (const row of keptRecords) {
      const path = importRecordPath(row.kind, row.lineage, heldPath.get(row.lineage) ?? null);
      place(path, sourceOf(row));
      files.push({ path, content: renderImportRecord(row) });
      placed.push({ row, path });
    }
    for (const policy of keptPolicies) {
      place(policy.path, policy.file);
      files.push({ path: policy.path, content: policy.text });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const now = deps.now();
    let branch: string | null = null;
    for (let n = 1; n <= BRANCHES_PER_DAY_MAX; n += 1) {
      const candidate = markdownImportBranch(now, n);
      if (!(await deps.branchTaken(scope, candidate))) {
        branch = candidate;
        break;
      }
    }
    if (branch === null) {
      throw refuse(
        "import_branches_exhausted",
        `The steering repo already has ${BRANCHES_PER_DAY_MAX} Markdown import branches for ${markdownImportBranch(now)}. Merge or delete some of them, then try again.`,
      );
    }

    const counts = [
      keptRecords.length > 0
        ? `${keptRecords.length} ${keptRecords.length === 1 ? "record" : "records"}`
        : null,
      keptPolicies.length > 0
        ? `${keptPolicies.length} ${keptPolicies.length === 1 ? "policy file" : "policy files"}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" and ");
    const title = `Import ${counts} from Markdown`;
    const opened = await deps.opener.open(scope, {
      branch,
      title,
      body: importPullRequestBody({ records: placed, policies: keptPolicies, skipped }),
      commitMessage: `steering: import ${counts} from Markdown`,
      files,
    });
    return {
      pullRequest: {
        number: opened.number,
        url: opened.url,
        branch: opened.branch,
        headSha: opened.headSha,
      },
      paths: files.map((file) => file.path),
      records: keptRecords.length,
      policies: keptPolicies.length,
      skipped,
    };
  };
}
