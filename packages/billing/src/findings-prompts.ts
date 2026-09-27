/**
 * findings-prompts.ts — the reads behind detector 6, prompt habits
 * (./findings/repeated-instructions.ts), and the call that opens a steering
 * record proposal for each instruction it finds.
 *
 * A prompt is the `turn_start` the `UserPromptSubmit` hook seals on the run's
 * own chain. The frame carries `prompt_digest` whatever the workspace keeps.
 * Its text is a body in the evidence store, kept only when the workspace's
 * retention policy keeps `model_call` bodies (`content_exact`). A body is
 * read back, checked against its digest, and decoded as UTF-8. One that
 * fails any of the three reads as no text.
 *
 * The pass runs outside a tenant scope, so each read that needs one enters
 * it for the workspace it reads.
 */
import { createHash } from "node:crypto";
import { readLatestRetentionPolicy, withSystemDb } from "@oxagen/database";
import { chSelect, type FrameRunRef } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  instructionProposalOpener,
  microsOf,
  promptRunsToPrice,
  type InstructionProposal,
  type PricedRequestFrame,
  type PromptRead,
  type PromptTextMode,
  type RunPrompt,
} from "./findings";
import { logger } from "./logger";

type Scope = { orgId: string; workspaceId: string };

/** Prompts one pass reads, newest first. */
export const PROMPT_READ_MAX = 20_000;
/** Prompt bodies one pass reads, newest first; an older prompt has no text. */
export const PROMPT_BODIES_MAX = 2_000;
/** Body reads one pass runs at once. */
const BODY_READ_CONCURRENCY = 8;
/** Runs one pass reads model-call frames for to price repeated prompts. */
export const PROMPT_FRAME_RUNS_MAX = 200;

/** Reads each named run's priced model-call frames; the findings store's own reader. */
export type PromptFrameReader = (
  scope: Scope,
  runs: readonly { runId: string; ref: FrameRunRef }[],
) => Promise<ReadonlyMap<string, readonly PricedRequestFrame[]>>;

/** One `turn_start` row as ClickHouse returns it. */
interface PromptRow {
  root_session_uuid: string;
  seq: string | number;
  at: string;
  prompt_digest: string;
  prompt_length: string | number | null;
  content_digest: string;
  bytes_ref: string;
}

/**
 * The operator prompts of the window, on each run's own chain. A slash
 * command (`command_name` set) is left out: its text is a template the
 * harness already keeps, not an instruction pasted into the run.
 */
const PROMPTS_QUERY = `SELECT toString(root_session_uuid) AS root_session_uuid, seq,
  formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS at,
  prompt_digest, prompt_length, content_digest, bytes_ref
  FROM tacho_events FINAL
  WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
    AND kind = 'turn_start'
    AND session_uuid = root_session_uuid
    AND ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
    AND received_at >= {from:DateTime64(3)} - INTERVAL 1 DAY
    AND prompt_digest != ''
    AND command_name = ''
  ORDER BY ts DESC, seq DESC
  LIMIT {limit:UInt32}`;

function chDateTime(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Whether the workspace keeps prompt text. A workspace with no policy row
 * keeps every class. A `content_exact` policy that leaves out `model_call`
 * keeps no prompt text, so it reads as `digest_only` here.
 */
export async function promptTextMode(scope: Scope): Promise<PromptTextMode> {
  const policy = await withSystemDb((tx) =>
    readLatestRetentionPolicy(tx, scope.orgId, scope.workspaceId),
  );
  if (policy === undefined) return "content_exact";
  return policy.mode !== "digest_only" &&
    policy.retainedContentClasses.includes("model_call")
    ? "content_exact"
    : "digest_only";
}

async function readPromptRows(
  scope: Scope,
  window: { start: Date; end: Date },
): Promise<PromptRow[]> {
  const result = await runInTenantScope(scope, () =>
    chSelect<PromptRow>({
      query: PROMPTS_QUERY,
      params: {
        from: chDateTime(window.start),
        to: chDateTime(window.end),
        limit: PROMPT_READ_MAX,
      },
    }),
  );
  return result.data;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A prompt body as text; null when it is missing, altered, or not UTF-8. */
async function bodyText(
  scope: Scope,
  row: PromptRow,
): Promise<string | null> {
  if (row.bytes_ref === "" || row.content_digest === "") return null;
  try {
    const { evidenceStore } = await import("@oxagen/run-ledger/evidence-store");
    const { bytes } = await runInTenantScope(scope, () =>
      evidenceStore().getBody(scope, row.bytes_ref),
    );
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== row.content_digest) return null;
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function lengthOf(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The window's prompts for the runs the pass read, their text when the
 * workspace keeps it, and the priced model-call frames of the runs whose
 * repeats a finding would price. Frames are read on each run's own chain
 * only, the chain its prompts are on.
 */
export async function readRunPrompts(
  scope: Scope,
  window: { start: Date; end: Date },
  runIdBySession: ReadonlyMap<string, string>,
  runIds: ReadonlySet<string>,
  readFrames: PromptFrameReader,
): Promise<PromptRead> {
  const [mode, rows] = await Promise.all([
    promptTextMode(scope),
    readPromptRows(scope, window),
  ]);
  const kept = rows.flatMap((row) => {
    const runId = runIdBySession.get(row.root_session_uuid);
    return runId !== undefined && runIds.has(runId) ? [{ row, runId }] : [];
  });
  const texts: (string | null)[] = kept.map(() => null);
  if (mode === "content_exact") {
    const reads = Math.min(kept.length, PROMPT_BODIES_MAX);
    for (let i = 0; i < reads; i += BODY_READ_CONCURRENCY) {
      const batch = kept.slice(i, Math.min(i + BODY_READ_CONCURRENCY, reads));
      const read = await Promise.all(batch.map((k) => bodyText(scope, k.row)));
      read.forEach((text, j) => (texts[i + j] = text));
    }
  }
  const prompts: RunPrompt[] = kept.map(({ row, runId }, i) => ({
    runId,
    seq: Number(row.seq),
    at: new Date(row.at),
    atMicros: microsOf(row.at),
    digest: row.prompt_digest,
    length: lengthOf(row.prompt_length),
    text: texts[i] ?? null,
  }));
  const rootByRun = new Map<string, string>();
  for (const { row, runId } of kept) rootByRun.set(runId, row.root_session_uuid);
  const priced = promptRunsToPrice(
    { mode, prompts },
    runIds,
    PROMPT_FRAME_RUNS_MAX,
  );
  const frames =
    priced.length === 0
      ? new Map<string, readonly PricedRequestFrame[]>()
      : await readFrames(
          scope,
          priced.map((runId) => {
            const root = rootByRun.get(runId)!;
            return {
              runId,
              ref: {
                kind: "tacho" as const,
                rootSessionUuid: root,
                sessionUuids: [root],
              },
            };
          }),
        );
  return { mode, prompts, frames };
}

/**
 * Open a steering record proposal for each repeated instruction through the
 * opener the handlers install. A pass in a process without the handlers, or
 * a failed open, writes its findings all the same: the next pass opens the
 * proposals again, and a lineage that already has one is left alone.
 */
export async function openInstructionProposals(
  scope: Scope,
  proposals: readonly InstructionProposal[],
): Promise<void> {
  if (proposals.length === 0) return;
  const open = instructionProposalOpener();
  if (open === null) {
    logger.warn(
      { ...scope, proposals: proposals.length },
      "findings: no steering record proposal opener installed",
    );
    return;
  }
  try {
    await open(scope, proposals);
  } catch (err) {
    logger.error(
      { ...scope, proposals: proposals.length, err },
      "findings: opening steering record proposals failed",
    );
  }
}
