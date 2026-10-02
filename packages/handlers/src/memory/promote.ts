// promote.ts: a person's draft steering records, from the memories they
// selected, onto a memory PR (memory-collection spec, Promotion; ADR-206,
// ADR-248).
//
// The drafts take the curator's path to the steering repo. They join the
// newest open memory PR as one commit on its branch, or, when none is open,
// they open the day's memory PR on `memory/<date>` the way the curator opens
// it. Each record cites its memories in `provenance.memories`, and the memory
// PR row lists it, so the curator settles the PR as it settles its own.
//
// Only a waiting memory is cited. A memory whose statement an open memory PR
// already proposes is skipped, so one lesson never sits in two open PRs.
//
// A promoted memory record goes where the curator puts one, under
// steering/memory/. Every other kind goes to its kind's folder, as
// open_context_pr and the Markdown import write it: a promoted code rule is
// a steering record like any other, and the curator's stale check, which
// reads only steering/memory/, never proposes archiving it.
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import type {
  MemoryDraftRecord,
  PromotableKind,
} from "@oxagen/oxagen/contracts/steering.memories.shared";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { STEERING_DIR } from "@oxagen/oxagen/steering-repo/paths";
import {
  defaultForceFor,
  forcesFor,
} from "@oxagen/oxagen/steering-repo/record-force";
import type {
  ProvenanceMemory,
  RecordEffect,
  RecordForce,
} from "@oxagen/oxagen/steering-repo/record";
import type { SteeringHost, SteeringRepository } from "../context.steering.github";
import { importRecordPath } from "../markdown-import/render";
import { readSteeringLayout } from "../steering-repo/merge-queue";
import { MEMORY_PR_FILES_MAX, memoryBranch } from "./curate";
import { memoryLineage, memoryRecordPath, memoryShard } from "./naming";
import { memoryRecordKind, renderPromotedRecord } from "./record-file";
import { prepareBranch, readRecords } from "./runner";
import { saysSame } from "./statement";
import type { MemoryPrRecord, MemoryScope, MemoryStore, OpenMemoryPr } from "./types";
import type { WorkspaceMemoryRow, WorkspaceMemoryStore } from "./workspace-store";

/** What promotion reads and writes through. Tests pass fakes. */
export interface PromoteDeps {
  host: SteeringHost;
  store: Pick<MemoryStore, "listOpenPrs" | "openedPrFrom" | "insertMemoryPr">;
  workspace: Pick<
    WorkspaceMemoryStore,
    "findMemories" | "listMemories" | "appendMemoryPrRecords"
  >;
  now(): Date;
}

export type SkipReason = "not_found" | "not_waiting" | "already_proposed";

/** One record promotion added to the memory PR. */
export interface PromotedRecord {
  path: string;
  lineage: string;
  kind: PromotableKind;
  force: RecordForce;
  effect: RecordEffect | null;
  /** The public ids of the memories it cites. */
  memoryIds: string[];
}

export interface PromoteResult {
  pullRequest: {
    number: number;
    url: string;
    branch: string;
    opened: boolean;
  } | null;
  records: PromotedRecord[];
  skipped: Array<{ memoryId: string; reason: SkipReason }>;
}

/** A draft once its memories are known. */
interface ResolvedDraft {
  memories: WorkspaceMemoryRow[];
  statement: string;
  kind: PromotableKind;
  force: RecordForce;
  effect: RecordEffect | null;
  repos: string[] | null;
}

/** The waiting memories the same-text search reads, the curator's batch ceiling. */
const SAME_TEXT_SCAN_MAX = 2_000;

/** The most `memory/<date>-<n>` branches tried when today's branch already had a PR. */
const BRANCH_SUFFIX_MAX = 9;

function refuse(reason: string, message: string): never {
  throw new HandlerError({ code: "conflict", reason, message });
}

/**
 * The kind a draft takes when the person names none: the kind the curator
 * would write, which is code-rule, business-rule, fact, or memory. None of
 * them needs an effect.
 */
function promotable(kind: WorkspaceMemoryRow["kind"]): PromotableKind {
  return memoryRecordKind(kind) as PromotableKind;
}

/** The kind, force, and effect a draft carries, checked against the kind's rule. */
function chooseForce(
  draft: MemoryDraftRecord,
  first: WorkspaceMemoryRow,
): Pick<ResolvedDraft, "kind" | "force" | "effect"> {
  const kind = draft.kind ?? promotable(first.kind);
  const force = draft.force ?? defaultForceFor(kind);
  if (!forcesFor(kind).includes(force))
    refuse(
      "force_not_allowed",
      `A ${kind} record cannot carry force ${force}. Use one of: ${forcesFor(kind).join(", ")}.`,
    );
  if (kind === "constraint" && draft.effect === undefined)
    refuse(
      "effect_required",
      "A constraint record names its effect. Pass effect require or forbid.",
    );
  if (kind !== "constraint" && draft.effect !== undefined)
    refuse(
      "effect_not_allowed",
      `Only a constraint record has an effect, and this draft is a ${kind}.`,
    );
  return { kind, force, effect: draft.effect ?? null };
}

/** The provenance `uri`: the first cited run's page, else the first source, else `oxagen:memory`. */
function provenanceUri(memories: readonly WorkspaceMemoryRow[]): string {
  for (const memory of memories)
    if (memory.runPublicId !== null) return `oxagen:run/${memory.runPublicId}`;
  return memories[0]?.source ?? "oxagen:memory";
}

function provenanceMemory(memory: WorkspaceMemoryRow): ProvenanceMemory {
  return {
    agent: memory.agentLineage,
    run: memory.runPublicId,
    statement: memory.statement,
    evidence: [...memory.evidence],
  };
}

/**
 * Where a promoted record lives: a memory where the curator puts one, in its
 * repository's shard, and every other kind at `steering/<kind folder>/<lineage>.md`.
 */
function recordPath(
  draft: ResolvedDraft,
  first: WorkspaceMemoryRow,
  lineage: string,
): string {
  return draft.kind === "memory"
    ? memoryRecordPath(draft.repos, first.appliesTo, first.tools, lineage)
    : importRecordPath(draft.kind, lineage);
}

/** A path's file name without `.md`, which is the lineage a record there usually has. */
function lineageOfPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One record's lines in a memory PR body. */
function recordLines(record: PromotedRecord, draft: ResolvedDraft): string[] {
  const runs = new Set(
    draft.memories.flatMap((memory) =>
      memory.runPublicId === null ? [] : [memory.runPublicId],
    ),
  );
  const memories = plural(draft.memories.length, "memory", "memories");
  const cites =
    runs.size === 0
      ? `It cites ${memories} with no run.`
      : `It cites ${memories} from ${plural(runs.size, "run", "runs")}.`;
  return [
    `- \`${record.path}\`, a ${record.kind} with force ${record.force}. ${cites}`,
    `  > ${draft.statement.trim().replace(/\s+/g, " ")}`,
  ];
}

/** The body of a memory PR a person opens. */
function openedBody(lines: string[]): string {
  return [
    "A person promoted these memories into steering records from the Memories tab, the CLI, or MCP.",
    "",
    "## Proposed steering records",
    "",
    ...lines,
    "",
    "## Review",
    "",
    "Merge this PR to adopt every record in it. Close it to reject every record.",
    "To reject one proposed record, delete its file before you merge.",
    "Oxagen proposes a rejected statement again only after memories from 2 more runs repeat it.",
    "",
  ].join("\n");
}

/** An open memory PR's body with the promoted records added. */
function joinedBody(body: string, lines: string[]): string {
  return `${body.trimEnd()}\n\n## Promoted records\n\nA person added these records from the Memories tab, the CLI, or MCP.\n\n${lines.join("\n")}\n`;
}

/**
 * Resolve each draft's memories in input order. A memory a draft already
 * cites is not cited again by a later one.
 */
async function resolveDrafts(
  deps: PromoteDeps,
  scope: MemoryScope,
  drafts: readonly MemoryDraftRecord[],
  sameText: boolean,
  proposed: ReadonlySet<string>,
): Promise<{ resolved: ResolvedDraft[]; skipped: PromoteResult["skipped"] }> {
  const requested = drafts.flatMap((draft) => draft.memory_ids);
  const found = await deps.workspace.findMemories(scope, requested);
  const byPublicId = new Map(found.map((row) => [row.publicId.toLowerCase(), row]));
  const waiting = sameText
    ? (
        await deps.workspace.listMemories(
          scope,
          { states: ["waiting"] },
          SAME_TEXT_SCAN_MAX,
        )
      ).rows
    : [];

  const cited = new Set<string>();
  const skipped: PromoteResult["skipped"] = [];
  const skippedIds = new Set<string>();
  const skip = (memoryId: string, reason: SkipReason) => {
    if (skippedIds.has(memoryId)) return;
    skippedIds.add(memoryId);
    skipped.push({ memoryId, reason });
  };
  const resolved: ResolvedDraft[] = [];
  for (const draft of drafts) {
    const memories: WorkspaceMemoryRow[] = [];
    for (const memoryId of draft.memory_ids) {
      const row = byPublicId.get(memoryId.toLowerCase());
      if (row === undefined) skip(memoryId, "not_found");
      else if (cited.has(row.id)) continue;
      else if (row.state !== "waiting") skip(row.publicId, "not_waiting");
      else if (proposed.has(row.statementHash)) skip(row.publicId, "already_proposed");
      else {
        cited.add(row.id);
        memories.push(row);
      }
    }
    const first = memories[0];
    if (first === undefined) continue;
    // Waiting memories that say what the first one says, in its repository,
    // join the record, so the curator does not propose them again.
    const shard = memoryShard(first.repos);
    for (const row of waiting) {
      if (cited.has(row.id) || proposed.has(row.statementHash)) continue;
      if (memoryShard(row.repos) !== shard) continue;
      if (
        row.statementHash !== first.statementHash &&
        !saysSame(row.statement, first.statement)
      )
        continue;
      cited.add(row.id);
      memories.push(row);
    }
    resolved.push({
      memories,
      statement: draft.statement ?? first.statement,
      repos: draft.repos ?? first.repos,
      ...chooseForce(draft, first),
    });
  }
  return { resolved, skipped };
}

/** The open memory PR the drafts join, and its branch head, or null when none can take them. */
async function joinablePr(
  deps: PromoteDeps,
  repo: SteeringRepository,
  open: readonly OpenMemoryPr[],
): Promise<{ pr: OpenMemoryPr; head: string } | null> {
  const candidates = open
    .filter(
      (pr) => pr.provider === repo.provider && pr.repository === repo.fullName,
    )
    .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
  for (const pr of candidates) {
    const state = await deps.host.getPullRequest(repo, pr.number);
    if (!state.open) continue;
    const head = await deps.host.branchHead(repo, pr.branch);
    if (head !== null) return { pr, head };
  }
  return null;
}

/**
 * Promote the drafts. Throws a HandlerError when the workspace has no
 * steering repo, when a draft's kind, force, or effect do not fit together,
 * or when the drafts would push the memory PR past 299 files.
 */
export async function promoteMemories(
  deps: PromoteDeps,
  scope: MemoryScope,
  input: { drafts: readonly MemoryDraftRecord[]; sameText: boolean },
): Promise<PromoteResult> {
  const openPrs = await deps.store.listOpenPrs(scope);
  const proposed = new Set(
    openPrs.flatMap((pr) =>
      pr.records.flatMap((record) =>
        record.action === "propose" ? record.statementHashes : [],
      ),
    ),
  );
  const { resolved, skipped } = await resolveDrafts(
    deps,
    scope,
    input.drafts,
    input.sameText,
    proposed,
  );
  if (resolved.length === 0) return { pullRequest: null, records: [], skipped };

  const repo = await deps.host.resolveRepository(scope);
  const layout = await readSteeringLayout(deps.host, repo);
  if (layout.layout !== "steering")
    refuse(
      "steering_repo_required",
      `${repo.fullName} has no steering/governance.toml on ${repo.defaultBranch}. Set up the steering repo before you promote memories.`,
    );
  const base = await deps.host.branchHead(repo, repo.defaultBranch);
  if (base === null)
    throw new Error(
      `[memory] the steering repository ${repo.fullName} has no ${repo.defaultBranch} branch`,
    );
  const { paths, records } = await readRecords(deps.host, repo, base);
  const join = await joinablePr(deps, repo, openPrs);
  if (join !== null) {
    for (const path of await deps.host.listFiles(repo, join.head, STEERING_DIR))
      paths.add(path);
    const files = join.pr.records.length + resolved.length;
    if (files > MEMORY_PR_FILES_MAX)
      refuse(
        "memory_pr_full",
        `Memory PR #${join.pr.number} would change ${files} files, and one memory PR changes at most ${MEMORY_PR_FILES_MAX}. Merge or close it, then promote again.`,
      );
  } else if (resolved.length > MEMORY_PR_FILES_MAX) {
    refuse(
      "memory_pr_full",
      `One memory PR changes at most ${MEMORY_PR_FILES_MAX} files. Promote fewer drafts.`,
    );
  }

  const taken = new Set<string>(records.map((record) => record.lineage));
  for (const pr of openPrs) for (const record of pr.records) taken.add(record.lineage);
  for (const path of paths) {
    const lineage = lineageOfPath(path);
    if (lineage !== null) taken.add(lineage);
  }

  const files: Array<{ path: string; content: string }> = [];
  const promoted: PromotedRecord[] = [];
  const ledger: MemoryPrRecord[] = [];
  const lines: string[] = [];
  for (const draft of resolved) {
    let lineage = memoryLineage(draft.statement, taken);
    const first = draft.memories[0] as WorkspaceMemoryRow;
    let path = recordPath(draft, first, lineage);
    while (paths.has(path)) {
      taken.add(lineage);
      lineage = memoryLineage(draft.statement, taken);
      path = recordPath(draft, first, lineage);
    }
    taken.add(lineage);
    paths.add(path);
    let content: string;
    try {
      content = renderPromotedRecord({
        lineage,
        kind: draft.kind,
        force: draft.force,
        effect: draft.effect,
        statement: draft.statement,
        repos: draft.repos,
        appliesTo: first.appliesTo,
        tools: first.tools,
        uri: provenanceUri(draft.memories),
        memories: draft.memories.map(provenanceMemory),
      });
    } catch (err) {
      refuse(
        "record_unreadable",
        `The record for "${draft.statement.slice(0, 80)}" would not read as a steering record: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    files.push({ path, content });
    const record: PromotedRecord = {
      path,
      lineage,
      kind: draft.kind,
      force: draft.force,
      effect: draft.effect,
      memoryIds: draft.memories.map((memory) => memory.publicId),
    };
    promoted.push(record);
    ledger.push({
      action: "propose",
      lineage,
      path,
      kind: draft.kind,
      memoryIds: draft.memories.map((memory) => memory.id),
      statementHashes: [...new Set(draft.memories.map((memory) => memory.statementHash))],
    });
    lines.push(...recordLines(record, draft));
  }
  const message = `Promote ${plural(files.length, "memory record", "memory records")}`;

  if (join !== null) {
    const { pr, head } = join;
    await deps.host.commitFiles(repo, {
      branch: pr.branch,
      parent: head,
      message,
      files,
    });
    const found = await deps.host.findOpenPullRequest(repo, {
      head: pr.branch,
      base: repo.defaultBranch,
    });
    if (found !== null)
      await deps.host.updatePullRequest(repo, {
        number: pr.number,
        title: `Memory PR ${pr.branch.slice("memory/".length)}`,
        body: joinedBody(found.body, lines),
      });
    if (!(await deps.workspace.appendMemoryPrRecords(scope, pr.id, ledger)))
      refuse(
        "memory_pr_settled",
        `Memory PR #${pr.number} settled while the records were added. Promote the memories again.`,
      );
    return {
      pullRequest: { number: pr.number, url: pr.url, branch: pr.branch, opened: false },
      records: promoted,
      skipped,
    };
  }

  const now = deps.now();
  const today = memoryBranch(now);
  let branch: string | null = null;
  for (let n = 1; n <= BRANCH_SUFFIX_MAX && branch === null; n += 1) {
    const candidate = n === 1 ? today : `${today}-${n}`;
    if (await deps.store.openedPrFrom(scope, candidate)) continue;
    if (await prepareBranch(deps.host, repo, candidate, base)) branch = candidate;
  }
  if (branch === null)
    refuse(
      "memory_branch_taken",
      `Every memory branch for ${today.slice("memory/".length)} already has a PR. Merge or close one, then promote again.`,
    );
  const title = `Memory PR ${branch.slice("memory/".length)}`;
  await deps.host.commitFiles(repo, { branch, parent: base, message: title, files });
  const pr = await deps.host.openPullRequest(repo, {
    title,
    head: branch,
    base: repo.defaultBranch,
    body: openedBody(lines),
    labels: OXAGEN_PR_LABELS,
  });
  await deps.store.insertMemoryPr(scope, {
    provider: repo.provider,
    repository: repo.fullName,
    branch,
    number: pr.number,
    url: pr.htmlUrl,
    records: ledger,
  });
  return {
    pullRequest: { number: pr.number, url: pr.htmlUrl, branch, opened: true },
    records: promoted,
    skipped,
  };
}
