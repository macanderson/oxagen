// run-fit.ts: the Model fit reading of one sealed run, computed from the
// record and stored on the run (#3893, ADR-194).
//
// The durable `run.fit` job (@oxagen/inngest-functions) asks for a reading
// after the cost rollup lands a sealed run's row. It cannot import this
// package, so `register.ts` installs `writeRunFitReading` behind the job's
// runner seam at boot, as the steering sync is (ADR-184).
//
// The reading reads what the Run page reads, from the same code:
// - the row `list_runs` builds for the run: its turns, steps, model class,
//   enforcement tier and seal;
// - the run's effort as `get_run` answers it (`runEffortOf`);
// - the transcript's figures (`transcriptFigures`) over the same frames and
//   the same word marking `get_run_transcript` uses, so a prompt of only
//   whitespace counts nowhere;
// - the output and reasoning tokens on the run's `cost.run_totals` row.
//
// It computes `runFit` and writes the four fit columns together, with the
// seal it read, so `get_run` answers a reading only for the seal it read.
import { schema, withTenantDb } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import {
  RUN_FIT_METHOD,
  runFit,
  type RunFit,
  type RunFitRead,
  type RunFitReading,
  runFitReadingSchema,
} from "@oxagen/oxagen/run-fit";
import {
  markWords,
  readTranscriptFrames,
  stepFolds,
  TRANSCRIPT_FRAME_CAP,
  transcriptFigures,
} from "@oxagen/run-ledger";
import type { EvidenceStore } from "@oxagen/run-ledger/evidence-store";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { and, eq } from "drizzle-orm";
import { readWords } from "../run.transcript.get";
import type { RunScope } from "../run.list";
import {
  defaultRunReadDeps,
  type ResolvedSource,
  resolveSource,
  runChainReads,
  type RunReadDeps,
} from "./run-read";
import { readSessionConfig, runEffortOf } from "./run-work";

/** The tokens the reading reads from the run's rollup row; null with no row. */
type RolledTokens = { output: number; reasoning: number } | null;

/** Which run a stored reading belongs to, in the store that recorded it. */
type FitTarget =
  | { source: "ledger"; runId: string }
  | { source: "tacho"; publicId: string };

/** The four fit columns, set together (`*_fit_check`). */
type StoredFit = {
  reading: unknown;
  method: string | null;
  readAt: Date | null;
  sealedAt: Date | null;
};

export type RunFitDeps = {
  read: RunReadDeps;
  bodies: Pick<EvidenceStore, "getBody" | "getAssembly">;
  sessionConfig: typeof readSessionConfig;
  readTokens: (scope: RunScope, runPublicId: string) => Promise<RolledTokens>;
  writeFit: (scope: RunScope, target: FitTarget, fit: RunFit) => Promise<boolean>;
  now: () => Date;
};

/** What one reading did: wrote the columns, or found nothing to read. */
type RunFitOutcome =
  | { outcome: "written"; fit: RunFit }
  | { outcome: "live" }
  | { outcome: "not_found" };

const targetOf = (run: ResolvedSource, publicId: string): FitTarget =>
  run.source === "ledger"
    ? { source: "ledger", runId: run.runId }
    : { source: "tacho", publicId };

/**
 * The figures the reading is keyed on, or null when the record lacks one: a
 * run whose turns the frames hide, or a transcript read past its cap, whose
 * counts are floors rather than counts.
 */
async function readFigures(
  deps: RunFitDeps,
  scope: RunScope,
  run: ResolvedSource,
  tokens: RolledTokens,
): Promise<RunFitRead | null> {
  const turns = run.item.turns;
  if (turns === null) return null;
  const frames = await readTranscriptFrames(
    runChainReads(deps.read, { ...run, witnessFor: null }),
    TRANSCRIPT_FRAME_CAP,
  );
  if (!frames.complete) return null;
  const steps = stepFolds(frames.frames);
  // The prompts' words decide which prompts count, as they do on the page.
  await markWords(
    steps.filter((step) => step.node === "prompt"),
    (needed) => readWords(deps.bodies, scope, needed),
  );
  const figures = transcriptFigures(frames.frames, steps);
  return {
    prompts: figures.prompts,
    turns,
    steps: run.item.steps,
    failed: figures.calls.failed,
    // Both vendors count thinking inside the output they publish; the rollup
    // carries it as a class of its own, so the output read adds it back.
    outputTokens: tokens === null ? null : tokens.output + tokens.reasoning,
    reasoningTokens: tokens === null ? null : tokens.reasoning,
  };
}

/**
 * Compute and store the reading for one run, inside the run's tenant scope.
 * A live run is left alone: the reading is of a seal. A run the store no
 * longer holds is `not_found`, which the job does not retry.
 */
export async function writeRunFitReading(
  deps: RunFitDeps,
  scope: RunScope,
  runPublicId: string,
): Promise<RunFitOutcome> {
  let run: ResolvedSource;
  try {
    run = await resolveSource(deps.read, scope, runPublicId);
  } catch (err) {
    if (isHandlerError(err) && err.code === "not_found")
      return { outcome: "not_found" };
    throw err;
  }
  const sealedAt = run.item.sealedAt;
  if (run.item.status === "live" || sealedAt === null)
    return { outcome: "live" };
  const [config, tokens] = await Promise.all([
    run.source === "tacho"
      ? deps.sessionConfig(run.sessionUuid)
      : Promise.resolve(null),
    deps.readTokens(scope, runPublicId),
  ]);
  const { effort, effortSource } = runEffortOf(config, run.item.effort);
  const read = await readFigures(deps, scope, run, tokens);
  const reading = runFit({
    tier: run.item.model?.tier ?? null,
    effort,
    effortSource,
    proxied:
      run.item.enforcementTier === "gateway" ||
      run.item.enforcementTier === "contained",
    read,
  });
  const fit: RunFit = {
    ...reading,
    method: RUN_FIT_METHOD,
    readAt: deps.now().toISOString(),
    sealedAt: new Date(sealedAt).toISOString(),
  };
  const written = await deps.writeFit(
    scope,
    targetOf(run, runPublicId),
    fit,
  );
  return written ? { outcome: "written", fit } : { outcome: "not_found" };
}

/**
 * The stored reading `get_run` answers, or null. Null for a live run, for a
 * run with no reading, for a reading of an earlier seal (the run was reopened
 * and sealed again since), and for a reading under a rule this build does not
 * read.
 */
export function storedFitOf(
  stored: StoredFit | null,
  sealedAt: string | null,
): RunFit | null {
  if (stored === null || sealedAt === null) return null;
  if (
    stored.method !== RUN_FIT_METHOD ||
    stored.readAt === null ||
    stored.sealedAt === null ||
    stored.sealedAt.getTime() !== Date.parse(sealedAt)
  )
    return null;
  const reading = runFitReadingSchema.safeParse(stored.reading);
  if (!reading.success) return null;
  return {
    ...reading.data,
    method: RUN_FIT_METHOD,
    readAt: stored.readAt.toISOString(),
    sealedAt: stored.sealedAt.toISOString(),
  };
}

/** The run's four fit columns, read by the run the store recorded. */
export async function readStoredFit(
  scope: RunScope,
  run: FitTarget,
): Promise<StoredFit | null> {
  const [row] =
    run.source === "tacho"
      ? await withTenantDb((tx) =>
          tx
            .select({
              reading: schema.tachoSessions.fitReading,
              method: schema.tachoSessions.fitMethod,
              readAt: schema.tachoSessions.fitReadAt,
              sealedAt: schema.tachoSessions.fitSealedAt,
            })
            .from(schema.tachoSessions)
            .where(
              and(
                eq(schema.tachoSessions.publicId, run.publicId),
                eq(schema.tachoSessions.orgId, scope.orgId),
                eq(schema.tachoSessions.workspaceId, scope.workspaceId),
              ),
            )
            .limit(1),
        )
      : await withTenantDb((tx) =>
          tx
            .select({
              reading: schema.agentRuns.fitReading,
              method: schema.agentRuns.fitMethod,
              readAt: schema.agentRuns.fitReadAt,
              sealedAt: schema.agentRuns.fitSealedAt,
            })
            .from(schema.agentRuns)
            .where(
              and(
                eq(schema.agentRuns.id, run.runId),
                eq(schema.agentRuns.orgId, scope.orgId),
                eq(schema.agentRuns.workspaceId, scope.workspaceId),
              ),
            )
            .limit(1),
        );
  return row ?? null;
}

/** The stored reading's body: the reading less its provenance, which has columns of its own. */
function readingOf(fit: RunFit): RunFitReading {
  return { read: fit.read, model: fit.model, effort: fit.effort };
}

/** Write the four fit columns together, on the run's own row. */
async function postgresWriteFit(
  scope: RunScope,
  target: FitTarget,
  fit: RunFit,
): Promise<boolean> {
  const columns = {
    fitReading: readingOf(fit),
    fitMethod: fit.method,
    fitReadAt: new Date(fit.readAt),
    fitSealedAt: new Date(fit.sealedAt),
    updatedAt: new Date(),
  };
  const rows =
    target.source === "tacho"
      ? await withTenantDb((tx) =>
          tx
            .update(schema.tachoSessions)
            .set(columns)
            .where(
              and(
                eq(schema.tachoSessions.publicId, target.publicId),
                eq(schema.tachoSessions.orgId, scope.orgId),
                eq(schema.tachoSessions.workspaceId, scope.workspaceId),
              ),
            )
            .returning({ id: schema.tachoSessions.id }),
        )
      : await withTenantDb((tx) =>
          tx
            .update(schema.agentRuns)
            .set(columns)
            .where(
              and(
                eq(schema.agentRuns.id, target.runId),
                eq(schema.agentRuns.orgId, scope.orgId),
                eq(schema.agentRuns.workspaceId, scope.workspaceId),
              ),
            )
            .returning({ id: schema.agentRuns.id }),
        );
  return rows.length > 0;
}

/** The run's output and reasoning tokens from its `cost.run_totals` row. */
async function postgresReadTokens(
  scope: RunScope,
  runPublicId: string,
): Promise<RolledTokens> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ tokens: schema.runTotals.tokens })
      .from(schema.runTotals)
      .where(
        and(
          eq(schema.runTotals.runId, runPublicId),
          eq(schema.runTotals.orgId, scope.orgId),
          eq(schema.runTotals.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  if (row === undefined) return null;
  const tokens = row.tokens as Record<string, unknown> | null;
  const count = (key: string): number => {
    const value = tokens?.[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : 0;
  };
  return { output: count("output"), reasoning: count("reasoning") };
}

export function defaultRunFitDeps(): RunFitDeps {
  return {
    read: defaultRunReadDeps(),
    bodies: evidenceStore(),
    sessionConfig: readSessionConfig,
    readTokens: postgresReadTokens,
    writeFit: postgresWriteFit,
    now: () => new Date(),
  };
}
