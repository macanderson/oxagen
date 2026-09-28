// runner.ts: the memory pipeline's reads and writes (ADR-206).
//
// The durable jobs in @oxagen/inngest-functions call these through the
// runner seam that register.ts installs: `run.reflect` captures a sealed
// run's memories and asks for a digest reflection, and `memory.curate`
// settles open memory PRs and opens the day's memory PR. Recall and the
// intake of memories from outside a run are called in process.
//
// Each step reads, hands what it read to a pure module (capture.ts,
// digest.ts, curate.ts, settle.ts, recall.ts), and writes what that module
// decided. Capture and the digest read the run the way the Run page does.
// The curator reads and writes the steering repo through the steering host.
import { generateObjectFor, selectModelForOrg } from "@oxagen/ai";
import { CREDIT_REASONS } from "@oxagen/billing";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import type {
  MemoryCaptureOutcome,
  MemoryCurateOutcome,
  MemoryDigestOutcome,
} from "@oxagen/inngest-functions/memory-runner";
import { lessonInputSchema } from "@oxagen/oxagen/contracts/agent.memory.lesson.remember";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import type { GovernanceSettings } from "@oxagen/oxagen/steering-repo/governance";
import { MEMORY_DIR, STEERING_DIR } from "@oxagen/oxagen/steering-repo/paths";
import {
  readSteeringRecord,
  recordStatement,
} from "@oxagen/oxagen/steering-repo/record";
import {
  readTranscriptFrames,
  type RunFrame,
  stepFolds,
  TRANSCRIPT_FRAME_CAP,
  type TranscriptFold,
  wordsHalf,
} from "@oxagen/run-ledger";
import {
  BodyKeyGoneError,
  BodyUnopenableError,
  type EvidenceStore,
  evidenceStore,
} from "@oxagen/run-ledger/evidence-store";
import { StorageNotFoundError } from "@oxagen/storage";
import { digestBytes } from "@oxagen/tacho";
import { z } from "zod";
import type {
  SteeringHost,
  SteeringRepository,
} from "../context.steering.github";
import { createSteeringHost } from "../context.steering.host";
import { mapConcurrent } from "../lib/map-concurrent";
import { readRunEnrichmentEnabled } from "../lib/run-enrichment";
import {
  defaultRunReadDeps,
  type ResolvedSource,
  resolveSource,
  runChainReads,
  type RunReadDeps,
} from "../lib/run-read";
import { logger } from "../logger";
import { readSteeringLayout } from "../steering-repo/merge-queue";
import {
  captureRun,
  lessonMemories,
  type MemoryToolCall,
  memoryToolOf,
} from "./capture";
import {
  memoryBranch,
  memoryPrBody,
  memoryPrTitle,
  planCuration,
} from "./curate";
import {
  type DigestReflection,
  digestReflectionPrompt,
  digestReflectionSchema,
  hasSignal,
  type RunStep,
  runSignals,
  toDigestReflection,
} from "./digest";
import { rankRecall } from "./recall";
import { archiveRecordText, renderMemoryRecord } from "./record-file";
import { settleMemoryPr } from "./settle";
import { statementHash } from "./statement";
import { postgresMemoryStore } from "./store";
import type {
  ActiveRecord,
  MemoryDraft,
  MemoryPrRecord,
  MemoryScope,
  MemoryStore,
  OpenMemoryPr,
  PlannedRecord,
  PlannedRetirement,
  RecallCandidate,
  RecallItem,
  RecallRequest,
} from "./types";

/** What the memory steps read and write through. Tests pass fakes. */
export interface MemoryRunnerDeps {
  read: RunReadDeps;
  bodies: Pick<EvidenceStore, "getBody">;
  store: MemoryStore;
  host: SteeringHost;
  /** Ask the fast tier for a run's reflection. */
  generate: (
    scope: MemoryScope,
    prompt: { system: string; prompt: string },
  ) => Promise<DigestReflection>;
  /** Does the workspace allow Oxagen to spend model calls on its runs? */
  enrichmentEnabled: (scope: MemoryScope) => Promise<boolean>;
}

/** The deps the API process runs with. */
export function defaultMemoryRunnerDeps(): MemoryRunnerDeps {
  return {
    read: defaultRunReadDeps(),
    bodies: evidenceStore(),
    store: postgresMemoryStore,
    host: createSteeringHost(),
    async generate(scope, { system, prompt }) {
      const { object } = await generateObjectFor({
        ...(await selectModelForOrg(scope.orgId, { tier: "fast" })),
        chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
        schema: digestReflectionSchema,
        system,
        prompt,
        temperature: 0.2,
        maxOutputTokens: 4096,
        // Inngest retries the step, so the call does not retry on its own.
        maxRetries: 0,
        telemetry: {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          surface: "runner" as const,
          messageId: null,
        },
      });
      return object;
    },
    enrichmentEnabled: readRunEnrichmentEnabled,
  };
}

// ── Reading a run ────────────────────────────────────────────────────────────

/** The most frame bodies or steering files one step reads at once. */
const READS_AT_ONCE = 8;

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A frame's body as text, or null when the frame has none or it cannot be
 * read. Capture is best effort: a body it cannot read counts as empty, as it
 * does on the Run page.
 */
async function readText(
  bodies: MemoryRunnerDeps["bodies"],
  scope: MemoryScope,
  frame: RunFrame | null,
): Promise<string | null> {
  if (frame === null) return null;
  const { bodyRef, bodyDigest } = frame.body;
  if (bodyRef === null || bodyDigest === null) return null;
  let stored: Awaited<ReturnType<typeof bodies.getBody>>;
  try {
    stored = await bodies.getBody(scope, bodyRef);
  } catch (err) {
    if (
      err instanceof StorageNotFoundError ||
      err instanceof BodyKeyGoneError ||
      err instanceof BodyUnopenableError
    )
      return null;
    logger.warn(
      { err, seq: frame.seq, bytesRef: bodyRef },
      "memory: a frame body could not be read; capture reads the frame as empty",
    );
    return null;
  }
  if (digestBytes(stored.bytes) !== bodyDigest) return null;
  try {
    return decoder.decode(stored.bytes);
  } catch {
    return null;
  }
}

/**
 * A tool call's input from its frame body. A body that holds the call as
 * `{input, output}` gives its `input`, and any other JSON is the input
 * itself. Text that is not JSON gives null, which no memory tool accepts.
 */
function toolInput(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "input" in parsed &&
    Object.keys(parsed).every((key) => key === "input" || key === "output")
  )
    return (parsed as { input: unknown }).input;
  return parsed;
}

type RunRead =
  | { state: "not_found" }
  | { state: "live" }
  | {
      state: "sealed";
      agentLineage: string | null;
      folds: TranscriptFold[];
    };

/**
 * The sealed run's steps, from its own chain. A subagent's memory calls are
 * not read: the subagent is a run of its own agent.
 */
async function readRun(
  deps: MemoryRunnerDeps,
  scope: MemoryScope,
  runPublicId: string,
): Promise<RunRead> {
  let run: ResolvedSource;
  try {
    run = await resolveSource(deps.read, scope, runPublicId);
  } catch (err) {
    if (isHandlerError(err) && err.code === "not_found")
      return { state: "not_found" };
    throw err;
  }
  if (run.item.status === "live" || run.item.sealedAt === null)
    return { state: "live" };
  const read = await readTranscriptFrames(
    {
      own: runChainReads(deps.read, { ...run, witnessFor: null }).own,
      subagents: null,
    },
    TRANSCRIPT_FRAME_CAP,
  );
  if (!read.complete) {
    logger.warn(
      { ...scope, runPublicId, frames: read.frames.length },
      "memory: the run holds more frames than one read takes; capture reads the first ones",
    );
  }
  return {
    state: "sealed",
    agentLineage: run.item.agentKey,
    folds: stepFolds(read.frames),
  };
}

/**
 * The run's memory tool calls, in frame order. A call still parked or
 * pending at the seal never ran, so it is skipped.
 */
async function memoryCalls(
  bodies: MemoryRunnerDeps["bodies"],
  scope: MemoryScope,
  folds: readonly TranscriptFold[],
): Promise<MemoryToolCall[]> {
  const calls = folds.filter(
    (fold): fold is TranscriptFold & { subject: string } =>
      fold.node === "tool" &&
      fold.subject !== null &&
      memoryToolOf(fold.subject) !== null &&
      fold.outcome !== "parked" &&
      fold.outcome !== "pending",
  );
  return mapConcurrent(calls, READS_AT_ONCE, async (fold) => {
    const text = await readText(
      bodies,
      scope,
      fold.request ?? fold.response ?? fold.opening,
    );
    return {
      seq: fold.opening.seq,
      tool: fold.subject,
      status: fold.outcome,
      input: text === null ? null : toolInput(text),
    };
  });
}

/** The run's steps as the digest reads them. Only a prompt's text is read. */
async function runSteps(
  bodies: MemoryRunnerDeps["bodies"],
  scope: MemoryScope,
  folds: readonly TranscriptFold[],
): Promise<RunStep[]> {
  return mapConcurrent(folds, READS_AT_ONCE, async (fold): Promise<RunStep> => {
    const seq = fold.opening.seq;
    if (
      fold.node === "tool" ||
      (fold.node === "policy" && fold.outcome === "denied")
    ) {
      return {
        seq,
        kind: "tool",
        tool: fold.subject,
        status: fold.outcome,
        inputDigest: fold.request?.body.bodyDigest ?? null,
        text: null,
      };
    }
    if (fold.node === "prompt") {
      return {
        seq,
        kind: "prompt",
        tool: null,
        status: null,
        inputDigest: null,
        text: await readText(bodies, scope, wordsHalf(fold)),
      };
    }
    return {
      seq,
      kind: "other",
      tool: null,
      status: fold.outcome,
      inputDigest: null,
      text: null,
    };
  });
}

// ── Capture and the digest ──────────────────────────────────────────────────

/**
 * Store what a sealed run recorded: each remember_lesson call as a memory,
 * and the last valid record_reflection call as the run's reflection, with
 * its lessons as memories. A retried capture writes nothing twice.
 *
 * A run whose agent Oxagen could not tell keeps its reflection and stores no
 * memories, because a memory is recalled by its agent.
 */
export async function captureMemories(
  deps: MemoryRunnerDeps,
  scope: MemoryScope,
  runPublicId: string,
): Promise<MemoryCaptureOutcome> {
  const run = await readRun(deps, scope, runPublicId);
  if (run.state !== "sealed")
    return {
      outcome: run.state,
      memories: 0,
      reflected: false,
      digest: false,
      waiting: 0,
    };
  const calls = await memoryCalls(deps.bodies, scope, run.folds);
  const captured = captureRun({
    runPublicId,
    agentLineage: run.agentLineage,
    calls,
  });
  const reflectionId =
    captured.reflection === null
      ? null
      : await deps.store.insertReflection(scope, captured.reflection);

  let memories = 0;
  if (run.agentLineage === null) {
    if (captured.memories.length > 0)
      logger.warn(
        { ...scope, runPublicId, memories: captured.memories.length },
        "memory: the run names no agent, so its memories are not stored",
      );
  } else {
    const lessonKeys = new Set(
      captured.reflection === null
        ? []
        : lessonMemories(captured.reflection).map((draft) => draft.dedupeKey),
    );
    const own = captured.memories.filter((m) => !lessonKeys.has(m.dedupeKey));
    const lessons = captured.memories.filter((m) =>
      lessonKeys.has(m.dedupeKey),
    );
    if (own.length > 0) memories += await deps.store.insertMemories(scope, own);
    if (lessons.length > 0)
      memories += await deps.store.insertMemories(scope, lessons, reflectionId);
  }

  // Only a wrapped run gets a digest: an in-app run is Oxagen's own agent.
  const digest =
    captured.reflection === null &&
    runPublicId.startsWith("tse_") &&
    !(await deps.store.hasReflection(scope, runPublicId)) &&
    hasSignal(runSignals(await runSteps(deps.bodies, scope, run.folds)));

  return {
    outcome: "captured",
    memories,
    reflected: captured.reflection !== null,
    digest,
    waiting: await deps.store.countWaiting(scope),
  };
}

/**
 * Write a reflection for a sealed run that shows a signal and holds none,
 * from its steps on the fast tier. The workspace's run enrichment setting
 * gates the model call.
 */
export async function digestRun(
  deps: MemoryRunnerDeps,
  scope: MemoryScope,
  runPublicId: string,
): Promise<MemoryDigestOutcome> {
  if (!(await deps.enrichmentEnabled(scope))) return "disabled";
  const run = await readRun(deps, scope, runPublicId);
  if (run.state !== "sealed") return "not_found";
  if (await deps.store.hasReflection(scope, runPublicId)) return "exists";
  const steps = await runSteps(deps.bodies, scope, run.folds);
  const signals = runSignals(steps);
  if (!hasSignal(signals)) return "no_signal";
  const output = await deps.generate(
    scope,
    digestReflectionPrompt({ runPublicId, signals, steps }),
  );
  const reflection = toDigestReflection(output, {
    runPublicId,
    agentLineage: run.agentLineage,
  });
  // One write: a reflection stored without its lessons would lose them, since
  // a retry finds the reflection and returns "exists".
  const reflectionId = await deps.store.insertReflection(
    scope,
    reflection,
    run.agentLineage === null ? [] : lessonMemories(reflection),
  );
  return reflectionId === null ? "exists" : "written";
}

// ── The curator ─────────────────────────────────────────────────────────────

/** The provenance `uri` of a record's first cited run. */
const runUri = (runPublicId: string): string => `oxagen:run/${runPublicId}`;

/**
 * Every file path under steering/ at `head`, and each file there that reads
 * as a steering record. A file that does not read is left out.
 */
async function readRecords(
  host: SteeringHost,
  repo: SteeringRepository,
  head: string,
): Promise<{ paths: Set<string>; records: ActiveRecord[] }> {
  const paths = await host.listFiles(repo, head, STEERING_DIR);
  const recordPaths = paths.filter((path) => path.endsWith(".md"));
  const texts = await mapConcurrent(recordPaths, READS_AT_ONCE, (path) =>
    host.readFile(repo, path, head),
  );
  const records: ActiveRecord[] = [];
  recordPaths.forEach((path, index) => {
    const text = texts[index];
    if (text === null || text === undefined) return;
    const read = readSteeringRecord(text);
    if (!read.ok) return;
    const { record } = read;
    records.push({
      path,
      lineage: record.lineage,
      kind: record.kind,
      status: record.status,
      statement: recordStatement(read.body),
      repos: record.repos ?? null,
      appliesTo: record.applies_to ?? null,
      tools: record.tools ?? null,
      text,
    });
  });
  return { paths: new Set(paths), records };
}

/**
 * Settle one memory PR the host has decided. Returns true when it settled,
 * and false while it stays open or cannot be read, so the next pass tries
 * again.
 */
async function settleOne(
  deps: MemoryRunnerDeps,
  scope: MemoryScope,
  repo: SteeringRepository,
  pr: OpenMemoryPr,
  now: Date,
): Promise<boolean> {
  const where = { ...scope, prId: pr.id, number: pr.number };
  if (pr.provider !== repo.provider || pr.repository !== repo.fullName) {
    logger.warn(
      { ...where, repository: pr.repository },
      "memory: a memory PR is on a repository the workspace no longer uses; it stays open",
    );
    return false;
  }
  let settlement: ReturnType<typeof settleMemoryPr>;
  try {
    const state = await deps.host.getPullRequest(repo, pr.number);
    if (state.merged && state.mergeCommitSha === null) {
      logger.warn(where, "memory: a merged memory PR has no merge commit yet");
      return false;
    }
    const present =
      state.merged && state.mergeCommitSha !== null
        ? new Set(
            await deps.host.listFiles(repo, state.mergeCommitSha, STEERING_DIR),
          )
        : new Set<string>();
    settlement = settleMemoryPr(
      pr,
      { open: state.open, merged: state.merged, mergedAt: state.mergedAt },
      present,
      now,
    );
  } catch (err) {
    logger.warn(
      { ...where, err },
      "memory: a memory PR could not be read; the next pass settles it",
    );
    return false;
  }
  if (settlement === null) return false;
  await deps.store.settlePr(scope, settlement);
  try {
    await deps.host.deleteBranch(repo, pr.branch);
  } catch (err) {
    logger.warn(
      { ...where, err, branch: pr.branch },
      "memory: a settled memory PR's branch could not be deleted",
    );
  }
  return true;
}

/**
 * Create today's branch at `head`, the default branch's commit the plan read.
 * A branch left by a pass that failed before it opened its PR is replaced.
 * The function returns false and leaves the branch alone when it already has
 * an open PR.
 */
export async function prepareBranch(
  host: SteeringHost,
  repo: SteeringRepository,
  branch: string,
  head: string,
): Promise<boolean> {
  try {
    await host.ensureBranch(repo, branch, repo.defaultBranch, {
      exclusive: true,
      at: head,
    });
  } catch (err) {
    if (!(isHandlerError(err) && err.reason === "proposal_branch_exists"))
      throw err;
    const open = await host.findOpenPullRequest(repo, {
      head: branch,
      base: repo.defaultBranch,
    });
    if (open !== null) {
      logger.warn(
        { repository: repo.fullName, branch, number: open.number },
        "memory: today's memory branch has an open PR the memory ledger does not hold; the curator leaves it",
      );
      return false;
    }
    // The caller checked that no memory PR was opened from this branch, and
    // the host holds no open PR from it, so nothing anyone reviews is lost.
    await host.deleteBranch(repo, branch);
    await host.ensureBranch(repo, branch, repo.defaultBranch, {
      exclusive: true,
      at: head,
    });
  }
  // The default branch can move after the plan read it. The branch starts at
  // the head the plan read, because that head is the commit's parent. The
  // host creates it there in one call, so no reset follows and no push to the
  // branch can land between a read and a move.
  return true;
}

function proposeRecord(record: PlannedRecord): MemoryPrRecord {
  return {
    action: "propose",
    lineage: record.draft.lineage,
    path: record.path,
    kind: record.draft.kind,
    memoryIds: record.memoryIds,
    statementHashes: record.statementHashes,
  };
}

function retireRecord(retirement: PlannedRetirement): MemoryPrRecord {
  return {
    action: "retire",
    lineage: retirement.lineage,
    path: retirement.path,
    kind: retirement.kind,
    memoryIds: [],
    statementHashes: [],
  };
}

/**
 * One curate pass in one workspace: settle each decided memory PR, then, if
 * the workspace has not opened one today, plan and open the day's memory PR.
 */
export async function curateMemories(
  deps: MemoryRunnerDeps,
  scope: MemoryScope,
  now: Date,
): Promise<MemoryCurateOutcome> {
  const none = { settled: 0, dropped: 0, pullRequest: null };
  const [waitingCount, openPrs, recallRows] = await Promise.all([
    deps.store.countWaiting(scope),
    deps.store.listOpenPrs(scope),
    deps.store.listRecalls(scope),
  ]);
  if (waitingCount === 0 && openPrs.length === 0 && recallRows.length === 0)
    return { outcome: "idle", ...none };

  let repo: SteeringRepository;
  try {
    repo = await deps.host.resolveRepository(scope);
  } catch (err) {
    if (isHandlerError(err) && err.code === "not_found")
      return { outcome: "no_repository", ...none };
    throw err;
  }
  let settings: GovernanceSettings;
  try {
    const layout = await readSteeringLayout(deps.host, repo);
    if (layout.layout !== "steering")
      return { outcome: "no_governance", ...none };
    settings = layout.settings;
  } catch (err) {
    if (isHandlerError(err) && err.reason === "governance_unreadable")
      return { outcome: "no_governance", ...none };
    throw err;
  }

  const pending: OpenMemoryPr[] = [];
  let settled = 0;
  for (const pr of openPrs) {
    if (await settleOne(deps, scope, repo, pr, now)) settled += 1;
    else pending.push(pr);
  }

  const branch = memoryBranch(now);
  if (await deps.store.openedPrFrom(scope, branch))
    return { outcome: "opened_today", settled, dropped: 0, pullRequest: null };

  const head = await deps.host.branchHead(repo, repo.defaultBranch);
  if (head === null)
    throw new Error(
      `[memory] the steering repository ${repo.fullName} has no ${repo.defaultBranch} branch`,
    );
  const { paths, records } = await readRecords(deps.host, repo, head);
  const [waiting, rejections, recalls, reflections] = await Promise.all([
    deps.store.listWaiting(scope),
    deps.store.listRejections(scope),
    deps.store.listRecalls(scope),
    deps.store.listReflectionsSince(
      scope,
      new Date(now.getTime() - settings.retire_after_days * 86_400_000),
    ),
  ]);
  const plan = planCuration({
    now,
    governance: {
      batch_size: settings.batch_size,
      retire_after_days: settings.retire_after_days,
    },
    waiting,
    records,
    pending: pending.flatMap((pr) => pr.records),
    rejections,
    recalls,
    reflections,
    runUri,
  });
  if (plan.drops.length > 0)
    await deps.store.deleteMemories(
      scope,
      plan.drops.map((drop) => drop.memoryId),
    );
  if (plan.stampRecalls.length > 0)
    await deps.store.stampRecalls(scope, plan.stampRecalls, now);
  const dropped = plan.drops.length;

  // A record that cannot be written stays out of the PR. Its memories keep
  // waiting, and a retirement is proposed again by a later pass.
  const files: { path: string; content: string }[] = [];
  const proposed: PlannedRecord[] = [];
  for (const record of plan.records) {
    if (paths.has(record.path)) {
      logger.warn(
        { ...scope, path: record.path },
        "memory: a planned record's path already holds a file; the record is left out",
      );
      continue;
    }
    try {
      files.push({ path: record.path, content: renderMemoryRecord(record.draft) });
      proposed.push(record);
    } catch (err) {
      logger.warn(
        { ...scope, err, path: record.path },
        "memory: a planned record does not render; it is left out",
      );
    }
  }
  const retired: PlannedRetirement[] = [];
  for (const retirement of plan.retirements) {
    try {
      files.push({
        path: retirement.path,
        content: archiveRecordText(retirement.text),
      });
      retired.push(retirement);
    } catch (err) {
      logger.warn(
        { ...scope, err, path: retirement.path },
        "memory: a record to archive does not read; it is left out",
      );
    }
  }
  if (files.length === 0)
    return { outcome: "curated", settled, dropped, pullRequest: null };

  const opened = { ...plan, records: proposed, retirements: retired };
  const title = memoryPrTitle(now.toISOString().slice(0, 10), opened);
  if (!(await prepareBranch(deps.host, repo, branch, head)))
    return { outcome: "opened_today", settled, dropped, pullRequest: null };
  await deps.host.commitFiles(repo, {
    branch,
    parent: head,
    message: title,
    files,
  });
  const pr = await deps.host.openPullRequest(repo, {
    title,
    head: branch,
    base: repo.defaultBranch,
    body: memoryPrBody(opened),
    labels: OXAGEN_PR_LABELS,
  });
  await deps.store.insertMemoryPr(scope, {
    provider: repo.provider,
    repository: repo.fullName,
    branch,
    number: pr.number,
    url: pr.htmlUrl,
    records: [...proposed.map(proposeRecord), ...retired.map(retireRecord)],
  });
  return {
    outcome: "curated",
    settled,
    dropped,
    pullRequest: { number: pr.number, url: pr.htmlUrl },
  };
}

// ── Recall ──────────────────────────────────────────────────────────────────

/**
 * The memories one request receives: active memory records from the
 * caller's read of the steering repo, and waiting memories as governance
 * allows. Each record served counts as recalled, which keeps it from going
 * stale. Oxagen's in-app agent receives none.
 */
export async function recallMemories(
  store: MemoryStore,
  scope: MemoryScope,
  request: RecallRequest,
  records: readonly ActiveRecord[],
): Promise<RecallItem[]> {
  if (request.inApp) return [];
  const [recalls, waiting] = await Promise.all([
    store.listRecalls(scope),
    request.recallUnreviewed === "off"
      ? Promise.resolve([])
      : store.listWaiting(scope),
  ]);
  const reviewedAt = new Map(recalls.map((row) => [row.lineage, row.reviewedAt]));
  const candidates: RecallCandidate[] = [];
  for (const record of records) {
    if (record.status !== "active" || !record.path.startsWith(`${MEMORY_DIR}/`))
      continue;
    candidates.push({
      id: record.lineage,
      source: "record",
      agent: null,
      statement: record.statement,
      repos: record.repos,
      appliesTo: record.appliesTo,
      tools: record.tools,
      since: reviewedAt.get(record.lineage) ?? request.now,
    });
  }
  for (const memory of waiting) {
    candidates.push({
      id: memory.publicId,
      source: "memory",
      agent: memory.agentLineage,
      statement: memory.statement,
      repos: memory.repos,
      appliesTo: memory.appliesTo,
      tools: memory.tools,
      since: memory.createdAt,
    });
  }
  const items = rankRecall(request, candidates);
  const lineages = items
    .filter((item) => item.source === "record")
    .map((item) => item.id);
  if (lineages.length > 0) await store.bumpRecalls(scope, lineages, request.now);
  return items;
}

// ── Memories from outside a run ─────────────────────────────────────────────

const RUN_PUBLIC_ID = /^(arun|tse)_[0-9a-z]+$/;

/**
 * A memory from a code repository check or the local gateway. A memory from a
 * pull request names its agent and run together or neither, and a memory
 * from the local gateway names no run. Evidence is a list of URLs.
 */
export const memoryIntakeSchema = lessonInputSchema
  .omit({ evidence: true })
  .extend({
    capture: z.enum(["pull_request", "local_gateway"]),
    /** Where the memory came from, such as the pull request's URL. */
    source: z.string().trim().min(1).max(2000),
    agentLineage: z.string().trim().min(1).max(200).nullable(),
    runPublicId: z.string().regex(RUN_PUBLIC_ID).nullable(),
    evidence: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
  })
  .superRefine((input, ctx) => {
    if (
      input.capture === "pull_request" &&
      (input.agentLineage === null) !== (input.runPublicId === null)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runPublicId"],
        message: "a pull_request memory names its agent and run together, or neither",
      });
    if (input.capture === "local_gateway" && input.runPublicId !== null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runPublicId"],
        message: "a local_gateway memory names no run",
      });
  });

/**
 * Store memories from outside a run. They wait for the curator like any
 * other. An input the schema refuses is logged and counted, and one whose
 * capture, source, and statement were stored before is skipped.
 */
export async function ingestMemories(
  store: MemoryStore,
  scope: MemoryScope,
  inputs: readonly unknown[],
): Promise<{ written: number; refused: number }> {
  const drafts: MemoryDraft[] = [];
  let refused = 0;
  for (const raw of inputs) {
    const parsed = memoryIntakeSchema.safeParse(raw);
    if (!parsed.success) {
      refused += 1;
      logger.warn(
        { ...scope, issues: parsed.error.issues },
        "memory: a memory from outside a run was refused",
      );
      continue;
    }
    const input = parsed.data;
    const hash = statementHash(input.statement);
    drafts.push({
      agentLineage: input.agentLineage,
      runPublicId: input.runPublicId,
      capture: input.capture,
      statement: input.statement,
      statementHash: hash,
      kind: input.kind,
      repos: input.repos ?? null,
      appliesTo: input.applies_to ?? null,
      tools: input.tools ?? null,
      evidence: input.evidence,
      source: input.source,
      dedupeKey: `${input.capture}:${input.source}:${hash}`,
    });
  }
  const written =
    drafts.length === 0 ? 0 : await store.insertMemories(scope, drafts);
  return { written, refused };
}
