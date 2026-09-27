// What the curator puts in one workspace's next memory PR (ADR-206,
// decisions 6, 8, and 9).
//
// The plan takes six steps, in order. It proposes archiving memory records
// that a reflection contradicts or that no run recalled. It drops waiting
// memories that an active steering record already says, or that waited too
// long. It holds memories an open memory PR already proposes, and rejected
// statements with no new evidence. It groups the rest by lesson. It writes
// one steering record per group and cites at most `batch_size` memories.
// Last, it fits the PR to 299 changed files and leaves the rest queued. The
// plan reads no database and no clock. The runner passes `now` in.
import { MEMORY_DIR } from "@oxagen/oxagen/steering-repo/paths";
import type {
  ProvenanceMemory,
  RecordKind,
} from "@oxagen/oxagen/steering-repo/record";
import { memoryLineage, memoryRecordPath, memoryShard } from "./naming";
import { contradicts, saysSame } from "./statement";
import type {
  CurateInput,
  CuratePlan,
  PlannedRecord,
  PlannedRetirement,
  RecallStamp,
  RecentReflection,
  StoredMemory,
} from "./types";

const DAY_MS = 86_400_000;

/** Distinct runs that must repeat a rejected statement before the curator proposes it again. */
const REJECTED_RUNS_MIN = 2;

/**
 * Changed files in one memory PR. S3's merge queue refuses a steering PR that
 * changes 300 or more, on GitHub and GitLab, because GitHub's compare API
 * stops listing files at 300. Each proposed record and each archived record
 * is one file.
 */
export const MEMORY_PR_FILES_MAX = 299;

/** The provenance `uri` of a record whose memories name no run and no source. */
const MEMORY_URI_FALLBACK = "oxagen:memory";

/** The kinds a memory record keeps. The curator files any other kind as `memory`. */
const KEPT_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>([
  "code-rule",
  "business-rule",
  "fact",
]);

/** Memories that say the same thing in one shard. The oldest one speaks for the rest. */
interface Group {
  representative: StoredMemory;
  members: StoredMemory[];
}

/**
 * Why a memory record should be archived, or null when it should stay. A
 * contradiction wins over staleness. Only a reflection written after a person
 * last decided on the record counts.
 */
function retireReason(
  statement: string,
  stamp: RecallStamp,
  reflections: RecentReflection[],
  now: number,
  windowMs: number,
): PlannedRetirement["reason"] | null {
  const reviewedAt = stamp.reviewedAt.getTime();
  const contradicted = reflections.some(
    (reflection) =>
      reflection.createdAt.getTime() > reviewedAt &&
      reflection.lessons.some((lesson) =>
        contradicts(lesson.statement, statement),
      ),
  );
  if (contradicted) return "contradicted";
  if (now - stamp.lastRecalledAt.getTime() > windowMs) return "stale";
  return null;
}

/**
 * The memory records to archive, and those with no recall row. A record with
 * no row gets one stamped now, which starts its stale clock, and is not
 * archived this time. A record an open memory PR already names waits for
 * that PR.
 */
function planRetirements(
  input: CurateInput,
  pendingLineages: ReadonlySet<string>,
  now: number,
  windowMs: number,
): { retirements: PlannedRetirement[]; stampRecalls: string[] } {
  const stamps = new Map(input.recalls.map((stamp) => [stamp.lineage, stamp]));
  const retirements: PlannedRetirement[] = [];
  const stampRecalls = new Set<string>();
  for (const record of input.records) {
    if (
      record.status !== "active" ||
      !record.path.startsWith(`${MEMORY_DIR}/`) ||
      pendingLineages.has(record.lineage)
    ) {
      continue;
    }
    const stamp = stamps.get(record.lineage);
    if (stamp === undefined) {
      stampRecalls.add(record.lineage);
      continue;
    }
    const reason = retireReason(
      record.statement,
      stamp,
      input.reflections,
      now,
      windowMs,
    );
    if (reason === null) continue;
    retirements.push({
      path: record.path,
      lineage: record.lineage,
      kind: record.kind,
      reason,
      text: record.text,
    });
  }
  return { retirements, stampRecalls: [...stampRecalls] };
}

/**
 * Drop each waiting memory that waited longer than the window, and each one
 * an active steering record already says. Any active record counts, not only
 * a memory record.
 */
function dropMemories(
  input: CurateInput,
  now: number,
  windowMs: number,
): { drops: CuratePlan["drops"]; kept: StoredMemory[] } {
  const said = input.records
    .filter((record) => record.status === "active")
    .map((record) => record.statement);
  const drops: CuratePlan["drops"] = [];
  const kept: StoredMemory[] = [];
  for (const memory of input.waiting) {
    if (now - memory.createdAt.getTime() > windowMs) {
      drops.push({ memoryId: memory.id, reason: "expired" });
    } else if (said.some((statement) => saysSame(memory.statement, statement))) {
      drops.push({ memoryId: memory.id, reason: "said" });
    } else {
      kept.push(memory);
    }
  }
  return { drops, kept };
}

/** The run a memory came from, or its capture and source when it has no run. */
function runKey(memory: StoredMemory): string {
  return memory.runPublicId ?? `${memory.capture}:${memory.source ?? ""}`;
}

/**
 * Hold each memory whose statement an open memory PR already proposes. Hold
 * each rejected statement too, until memories from 2 distinct runs repeat it
 * after its latest rejection. Then every memory with that statement goes on,
 * the older ones included.
 */
function holdMemories(
  memories: StoredMemory[],
  input: CurateInput,
): { held: string[]; ready: StoredMemory[] } {
  const proposed = new Set<string>();
  for (const record of input.pending) {
    if (record.action !== "propose") continue;
    for (const hash of record.statementHashes) proposed.add(hash);
  }
  const rejectedAt = new Map<string, number>();
  for (const rejection of input.rejections) {
    const at = rejection.rejectedAt.getTime();
    const previous = rejectedAt.get(rejection.statementHash);
    if (previous === undefined || at > previous) {
      rejectedAt.set(rejection.statementHash, at);
    }
  }
  const newRuns = new Map<string, Set<string>>();
  for (const memory of memories) {
    const at = rejectedAt.get(memory.statementHash);
    if (at === undefined || memory.createdAt.getTime() <= at) continue;
    const runs = newRuns.get(memory.statementHash) ?? new Set<string>();
    runs.add(runKey(memory));
    newRuns.set(memory.statementHash, runs);
  }
  const held: string[] = [];
  const ready: StoredMemory[] = [];
  for (const memory of memories) {
    const hash = memory.statementHash;
    const stillRejected =
      rejectedAt.has(hash) &&
      (newRuns.get(hash)?.size ?? 0) < REJECTED_RUNS_MIN;
    if (proposed.has(hash) || stillRejected) held.push(memory.id);
    else ready.push(memory);
  }
  return { held, ready };
}

/**
 * Two memories carry one lesson when their statements say the same thing.
 * The hash test also joins a repeated statement that has no content words,
 * which `saysSame` cannot compare.
 */
function sameLesson(a: StoredMemory, b: StoredMemory): boolean {
  return a.statementHash === b.statementHash || saysSame(a.statement, b.statement);
}

/**
 * Group memories oldest first. Inside a shard, a memory joins the first group
 * whose representative says the same thing, or starts a group. The groups
 * come back in the order they started.
 */
function groupMemories(memories: StoredMemory[]): Group[] {
  const oldestFirst = [...memories].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const groups: Group[] = [];
  const byShard = new Map<string, Group[]>();
  for (const memory of oldestFirst) {
    const shard = memoryShard(memory.repos);
    const shardGroups = byShard.get(shard) ?? [];
    byShard.set(shard, shardGroups);
    const group = shardGroups.find((g) => sameLesson(g.representative, memory));
    if (group !== undefined) {
      group.members.push(memory);
      continue;
    }
    const started: Group = { representative: memory, members: [memory] };
    shardGroups.push(started);
    groups.push(started);
  }
  return groups;
}

/**
 * Cite whole groups in order until the next one would pass `batch_size`, and
 * defer that group and every one after it. A first group larger than the
 * whole batch could never fit, so its first `batch_size` memories are cited
 * and the rest deferred.
 */
function takeBatch(
  groups: Group[],
  batchSize: number,
): { cited: Group[]; deferred: string[] } {
  const limit = Math.max(1, batchSize);
  const cited: Group[] = [];
  const deferred: string[] = [];
  let count = 0;
  let full = false;
  for (const group of groups) {
    const size = group.members.length;
    if (!full && count + size <= limit) {
      cited.push(group);
      count += size;
      continue;
    }
    if (!full && count === 0) {
      cited.push({
        representative: group.representative,
        members: group.members.slice(0, limit),
      });
      for (const memory of group.members.slice(limit)) deferred.push(memory.id);
      full = true;
      continue;
    }
    full = true;
    for (const memory of group.members) deferred.push(memory.id);
  }
  return { cited, deferred };
}

/** The first cited run's page, else the representative's source, else `oxagen:memory`. */
function provenanceUri(group: Group, runUri: CurateInput["runUri"]): string {
  for (const memory of group.members) {
    if (memory.runPublicId !== null) return runUri(memory.runPublicId);
  }
  return group.representative.source ?? MEMORY_URI_FALLBACK;
}

/** A cited memory as the record's provenance keeps it, nulls kept. */
function provenanceMemory(memory: StoredMemory): ProvenanceMemory {
  return {
    agent: memory.agentLineage,
    run: memory.runPublicId,
    statement: memory.statement,
    evidence: [...memory.evidence],
  };
}

/** One steering record for one cited group. `taken` gains its lineage. */
function planRecord(
  group: Group,
  taken: Set<string>,
  runUri: CurateInput["runUri"],
): PlannedRecord {
  const { representative: rep, members } = group;
  const lineage = memoryLineage(rep.statement, taken);
  taken.add(lineage);
  return {
    path: memoryRecordPath(rep.repos, rep.appliesTo, rep.tools, lineage),
    draft: {
      lineage,
      kind: KEPT_KINDS.has(rep.kind) ? rep.kind : "memory",
      statement: rep.statement,
      repos: rep.repos,
      appliesTo: rep.appliesTo,
      tools: rep.tools,
      uri: provenanceUri(group, runUri),
      memories: members.map(provenanceMemory),
    },
    memoryIds: members.map((memory) => memory.id),
    statementHashes: [...new Set(members.map((memory) => memory.statementHash))],
  };
}

/** Plan one workspace's memory PR. The runner settles open memory PRs first. */
export function planCuration(input: CurateInput): CuratePlan {
  const now = input.now.getTime();
  const windowMs = input.governance.retire_after_days * DAY_MS;
  const pendingLineages = new Set(input.pending.map((record) => record.lineage));

  const { retirements, stampRecalls } = planRetirements(
    input,
    pendingLineages,
    now,
    windowMs,
  );
  const { drops, kept } = dropMemories(input, now, windowMs);
  const { held, ready } = holdMemories(kept, input);
  const { cited, deferred } = takeBatch(
    groupMemories(ready),
    input.governance.batch_size,
  );

  const fit = fitFiles(retirements, cited);

  const taken = new Set<string>(pendingLineages);
  for (const record of input.records) taken.add(record.lineage);
  const records = fit.groups.map((group) =>
    planRecord(group, taken, input.runUri),
  );

  return {
    drops,
    held,
    deferred: [...fit.deferred, ...deferred],
    records,
    retirements: fit.retirements,
    queuedRetirements: fit.queuedRetirements,
    stampRecalls,
  };
}

/**
 * Fit one PR to `MEMORY_PR_FILES_MAX` changed files. A contradicted record
 * goes first, since agents still receive its wrong advice. New records come
 * next, and stale records fill what room is left. A record that does not fit
 * keeps its memories waiting, and a retirement that does not fit is proposed
 * again by a later pass, so nothing is lost and the day still gets one PR.
 */
function fitFiles(
  retirements: PlannedRetirement[],
  groups: Group[],
): {
  retirements: PlannedRetirement[];
  queuedRetirements: string[];
  groups: Group[];
  deferred: string[];
} {
  const contradicted = retirements.filter((r) => r.reason === "contradicted");
  const stale = retirements.filter((r) => r.reason !== "contradicted");
  let room = MEMORY_PR_FILES_MAX;
  const keptContradicted = contradicted.slice(0, room);
  room -= keptContradicted.length;
  const keptGroups = groups.slice(0, room);
  room -= keptGroups.length;
  const keptStale = stale.slice(0, room);
  const deferred: string[] = [];
  for (const group of groups.slice(keptGroups.length)) {
    for (const memory of group.members) deferred.push(memory.id);
  }
  return {
    retirements: [...keptContradicted, ...keptStale],
    queuedRetirements: [
      ...contradicted.slice(keptContradicted.length),
      ...stale.slice(keptStale.length),
    ].map((r) => r.lineage),
    groups: keptGroups,
    deferred,
  };
}

/** The memory PR's title. */
export function memoryPrTitle(date: string, _plan: CuratePlan): string {
  return `Memory PR ${date}`;
}

/** The branch a day's memory PR opens from: `memory/<YYYY-MM-DD>`, in UTC. */
export function memoryBranch(now: Date): string {
  return `memory/${now.toISOString().slice(0, 10)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A statement on one line, for a list item. */
function oneLine(statement: string): string {
  return statement.trim().replace(/\s+/g, " ");
}

/** How many memories and runs a proposed record cites, as a sentence. */
function citesSentence(record: PlannedRecord): string {
  const memories = plural(record.draft.memories.length, "memory", "memories");
  const runs = new Set<string>();
  for (const memory of record.draft.memories) {
    if (memory.run !== null) runs.add(memory.run);
  }
  if (runs.size === 0) return `It cites ${memories} with no run.`;
  return `It cites ${memories} from ${plural(runs.size, "run", "runs")}.`;
}

const RETIRE_REASONS: Record<PlannedRetirement["reason"], string> = {
  contradicted: "A reflection written since its last review contradicts it.",
  stale: "No run recalled it within `retire_after_days`.",
};

/**
 * The memory PR's description: each proposed steering record with its
 * statement and what it cites, each record to archive with the reason, and
 * what merging and closing do.
 */
export function memoryPrBody(plan: CuratePlan): string {
  const lines: string[] = [
    "Oxagen's memory curator opened this PR from the memories agents kept in this workspace.",
    `It proposes ${plural(plan.records.length, "steering record", "steering records")} and archives ${plural(plan.retirements.length, "record", "records")}.`,
  ];
  if (plan.records.length > 0) {
    lines.push("", "## Proposed steering records", "");
    for (const record of plan.records) {
      lines.push(
        `- \`${record.path}\`. ${citesSentence(record)}`,
        `  > ${oneLine(record.draft.statement)}`,
      );
    }
  }
  if (plan.retirements.length > 0) {
    lines.push("", "## Records to archive", "");
    for (const retirement of plan.retirements) {
      lines.push(`- \`${retirement.path}\`. ${RETIRE_REASONS[retirement.reason]}`);
    }
  }
  if (plan.queuedRetirements.length > 0) {
    lines.push(
      "",
      `One memory PR changes at most ${MEMORY_PR_FILES_MAX} files, so ${plural(plan.queuedRetirements.length, "more record waits", "more records wait")} for a later memory PR to archive.`,
    );
  }
  lines.push(
    "",
    "## Review",
    "",
    "Merge this PR to adopt every change in it. Close it to reject every change.",
    "To reject one proposed record, delete its file before you merge.",
    "To keep a record this PR archives, revert its edit before you merge.",
    `Oxagen proposes a rejected statement again only after memories from ${REJECTED_RUNS_MIN} more runs repeat it.`,
    "",
  );
  return lines.join("\n");
}
