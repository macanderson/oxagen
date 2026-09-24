// run.summarize.ts — writes the generated name and summary `summarize_run`
// queued (Mission Control mockup 2821-2835; G14; ADR-058).
//
// Triggered by `run/summarize`. The handler already refused a live run and a
// digest_only recording. The job reads the run's frames in its tenant scope,
// folds them at the `steps` zoom, reads the retained bodies of the first
// SUMMARY_STEP_MAX steps (each cut at SUMMARY_TEXT_MAX characters), fails
// without retry when none of those steps kept a readable body (the prompt
// would hold step labels alone, the receipts-only summary the interface
// forbids), and asks
// the fast tier for a name and a summary through `@oxagen/ai` on the
// organisation's funding source, metered like every other model call. The
// three summary columns are written together with the model id
// (`modelIdOf`) that produced them.
import { generateObjectFor, modelIdOf, selectModelForOrg } from "@oxagen/ai";
import { CREDIT_REASONS } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { NonRetriableError } from "@oxagen/functions";
import { foldTranscript, type RunFrame } from "@oxagen/run-ledger";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes } from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createFunction } from "../create-function";
import { logger } from "../logger";
import {
  ledgerStore,
  readRunFrames,
  resolveRunRecord,
  type RunScope,
} from "../lib/run-record";

export const RUN_SUMMARIZE_EVENT = "run/summarize";

/** Steps the model reads; a longer run is summarised from its first steps. */
export const SUMMARY_STEP_MAX = 60;
/** Characters of body text per step. */
export const SUMMARY_TEXT_MAX = 4_000;
const NAME_MAX = 80;
const SUMMARY_MAX = 1_200;
const MODEL_TIMEOUT_MS = 60_000;

export const summarySchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
  summary: z.string().min(1).max(SUMMARY_MAX),
});

interface RunSummarizeEventData {
  orgId: string;
  workspaceId: string;
  runPublicId: string;
  requestedByUserId: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * One step of the transcript as the model reads it: what the call was made
 * with, and what came back. A step is two frames wherever the producer writes
 * two (`foldTranscript`), so reading only the frame that opens it would hand
 * the model a tool call's INPUT and call it the result.
 */
interface SummaryStep {
  seq: string;
  kind: string;
  label: string;
  /** The request half's body; null when there is none, or none was retained. */
  input: string | null;
  /** The response half's body — the result the summary describes. */
  text: string | null;
}

/**
 * The prompt's transcript: the first steps with their body text. Bodies
 * that were not retained, are not text, or do not hash to their digest read
 * as `null`, and the prompt says so.
 */
export async function collectSummarySteps(
  scope: RunScope,
  frames: readonly RunFrame[],
  getBody: (scope: RunScope, ref: string) => Promise<{ bytes: Uint8Array }>,
): Promise<{ steps: SummaryStep[]; total: number }> {
  const folds = foldTranscript(frames, "steps");
  const kept = folds.slice(0, SUMMARY_STEP_MAX);

  /** A frame's retained body as text, or null. */
  async function bodyText(frame: RunFrame | null): Promise<string | null> {
    if (frame === null) return null;
    const { bodyRef, bodyDigest } = frame.body;
    if (bodyRef === null || bodyDigest === null) return null;
    try {
      const { bytes } = await getBody(scope, bodyRef);
      if (digestBytes(bytes) !== bodyDigest) return null;
      return decoder.decode(bytes).slice(0, SUMMARY_TEXT_MAX);
    } catch {
      return null;
    }
  }

  const steps: SummaryStep[] = [];
  for (const fold of kept) {
    const { opening } = fold;
    // The response half is the result; a producer that appends a single
    // terminal receipt records it there too, so `opening` is only read when
    // the fold has neither half. A request with no response is a call that
    // never completed (a failed or abandoned attempt): it has no result, and
    // reading its opening would hand the model the input as what came back
    // (#3370).
    const result = fold.response ?? (fold.request === null ? opening : null);
    steps.push({
      seq: opening.seq,
      kind: fold.kind,
      label: opening.summary,
      input: await bodyText(fold.request),
      text: await bodyText(result),
    });
  }
  return { steps, total: folds.length };
}

export function summaryPrompt(
  runPublicId: string,
  collected: { steps: SummaryStep[]; total: number },
): string {
  const lines = collected.steps.map((step) =>
    [
      `[${step.seq}] ${step.kind} ${step.label}`,
      ...(step.input === null ? [] : [`called with: ${step.input}`]),
      step.text === null ? "(body not retained)" : step.text,
    ].join("\n"),
  );
  const cut =
    collected.total > collected.steps.length
      ? `\n(${collected.total - collected.steps.length} later steps omitted)`
      : "";
  return [
    `Run ${runPublicId}: the steps below are the recorded model calls and tool calls, in order, with the body of each where the workspace retained it.`,
    "Write a name of at most 80 characters that says what the run was for, and a summary of at most 1200 characters that says what the agent did and what changed. State only what the steps show; do not infer an outcome the record does not carry.",
    "",
    ...lines,
    cut,
  ].join("\n");
}

export const [runSummarize] = createFunction(
  {
    id: "run.summarize",
    retries: 2,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: RUN_SUMMARIZE_EVENT },
  async ({ event, step }) => {
    const data = event.data as unknown as RunSummarizeEventData;
    const scope = { orgId: data.orgId, workspaceId: data.workspaceId };

    const collected = await step.run("read-transcript", async () => {
      const record = await resolveRunRecord(scope, data.runPublicId);
      if (!record) {
        throw new NonRetriableError(
          `run ${data.runPublicId} is not in the job's workspace`,
        );
      }
      const frames = await readRunFrames(scope, record);
      const steps = await runInTenantScope(scope, () =>
        collectSummarySteps(scope, frames, (s, ref) =>
          evidenceStore().getBody(s, ref),
        ),
      );
      return { ...steps, source: record.source };
    });
    if (collected.steps.every((s) => s.text === null)) {
      throw new NonRetriableError(
        `run ${data.runPublicId} has no retained body to summarise`,
      );
    }

    const generated = await step.run("generate", async () => {
      // Model and funding resolved together (ADR-053 §3, ADR-131): the key the
      // call is built on and the party billed for it must be one answer.
      const { model, fundedBy } = await selectModelForOrg(data.orgId, {
        tier: "fast",
      });
      const { object } = await generateObjectFor({
        schema: summarySchema,
        model,
        fundedBy,
        chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
        prompt: summaryPrompt(data.runPublicId, collected),
        temperature: 0.2,
        maxOutputTokens: 800,
        telemetry: {
          orgId: data.orgId,
          workspaceId: data.workspaceId,
          surface: "runner" as const,
          messageId: null,
        },
        abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
        maxRetries: 0,
      });
      return {
        ...object,
        model: modelIdOf(model),
        generatedAt: new Date().toISOString(),
      };
    });

    await step.run("write-summary", async () => {
      const summary = {
        name: generated.name,
        summary: generated.summary,
        model: generated.model,
        generatedAt: new Date(generated.generatedAt),
      };
      const written = await runInTenantScope(scope, async () => {
        if (collected.source === "ledger") {
          const record = await resolveRunRecord(scope, data.runPublicId);
          if (!record || record.source !== "ledger") return false;
          return ledgerStore().setRunSummary(record.runId, summary);
        }
        const rows = await withTenantDb((tx) =>
          tx
            .update(schema.tachoSessions)
            .set({
              name: summary.name,
              summary: summary.summary,
              summaryModel: summary.model,
              summaryGeneratedAt: summary.generatedAt,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.tachoSessions.publicId, data.runPublicId),
                eq(schema.tachoSessions.orgId, data.orgId),
                eq(schema.tachoSessions.workspaceId, data.workspaceId),
              ),
            )
            .returning({ id: schema.tachoSessions.id }),
        );
        return rows.length > 0;
      });
      if (!written) {
        throw new NonRetriableError(
          `run ${data.runPublicId} vanished before its summary was written`,
        );
      }
    });

    logger.info(
      { runPublicId: data.runPublicId, model: generated.model },
      "run.summarize: summary written",
    );
    return { runPublicId: data.runPublicId, model: generated.model };
  },
);
