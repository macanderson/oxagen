/**
 * RunSpec **v1** — the retained LEGACY admission contract
 * (docs/specs/run-evidence-ingress/02-run-attempt-foundation-plan.md Task 6;
 * originally agent-engine v2 Phase 2, docs/specs/agent-engine-v2/plan.md).
 *
 * ## Why this file exists
 *
 * v1 was defined TWICE — once in `apps/api/src/routes/v1/agent.run.ts` (the
 * enqueue side) and once in `packages/agent/src/runtime/turn-driver.ts` (the
 * claim side) — with nothing keeping the two in sync but a comment. Task 6
 * centralizes it here so the writer and the reader of a legacy row share one
 * definition, and so the eventual all-V1 retirement is a single deletion
 * rather than a hunt.
 *
 * This module is deliberately NOT a deprecation shim that quietly forwards to
 * v2. The two contracts are not compatible and must not be conflated:
 *
 * ## RunSpec v1 rows are EXPLICITLY NON-EVIDENCE
 *
 * A v1 row carries none of the governed-run evidence chain:
 *
 * | v2 (`RunSpecV2`)                        | v1 (this file)              |
 * |-----------------------------------------|-----------------------------|
 * | trusted `actor_binding` (initiating human + agent principal + version checksum) | no principal at all |
 * | pinned `authorization_snapshot_ref` (`ras_`) | no pinned ceiling      |
 * | immutable `repository_binding` (`rpb_`) | no repository authority     |
 * | pinned `context_policy` retention version | no retention pinning      |
 * | fenced immutable attempts + seals + `afg_` finalization grants | run-global lease, no attempt identity |
 * | `run_seq`/`attempt_seq` + per-event digests | a single mutable `seq`, no digest |
 *
 * So a v1 row can never be promoted, backfilled, or re-labelled into a v2
 * governed run: doing that would mean INVENTING an initiating principal, a
 * grant ceiling, and repository authority that no human ever granted. Global
 * Constraint: *"Existing V1 history is never backfilled with invented
 * principals or repository authority."*
 *
 * What v1 rows DO get is honest treatment: they stay claimable
 * (`claimLegacyV1`), stay readable (the V1 `seq`-cursored SSE/replay path),
 * and stay labelled `spec_version = 1` forever — until retention cleanup or a
 * later compatibility retirement removes them.
 *
 * ## Code mode was never admitted through v1
 *
 * `isLegacyCodeModeSurface` exists so the *classification* of a legacy
 * code-mode row has exactly one definition shared by the admission gate, the
 * drain query, and PR 1B's contract guard. It is a labelling predicate, not a
 * claim that such rows exist: the only v1 admission path the platform ever
 * shipped is `POST /v1/:org/:ws/runs`, which enqueues `surface: "api-chat"`
 * conversational turns. `agent.repo.edit` runs IN-REQUEST and never enqueued a
 * durable run, so the durable queue holds no `repo-edit` v1 rows to drain.
 * PR 1B's `DO` assertion is expected to pass trivially — which is a fact to
 * VERIFY against the deployed database, not to assume from this comment.
 */
import { z } from "zod";

/** Every v1 row carries exactly this literal in `agent_runs.spec.version`. */
export const LEGACY_RUN_SPEC_VERSION = 1;

/**
 * `PlatformSurface` values that denote **code mode** — a run that edits a
 * repository or executes commands in a sandbox, and therefore the class of run
 * PR 1B refuses to admit as v1 (governed code-mode work must carry a pinned
 * repository binding, which only `RunSpecV2` has).
 *
 * `repo-edit` is the only member today. Kept as a set rather than an equality
 * check so adding a second code-mode surface updates one place.
 */
export const LEGACY_CODE_MODE_SURFACES: ReadonlySet<string> = new Set([
  "repo-edit",
]);

/**
 * True when a legacy row's `surface` denotes governed code-mode work.
 *
 * The v1 spec body carries NO run-kind discriminator — `run_kind` is a v2
 * concept — so `surface` on the `agent_runs` row is the only signal a legacy
 * row has. That is exactly why v1 cannot govern code mode: the classification
 * lives outside the signed/hashed spec.
 */
export function isLegacyCodeModeSurface(surface: string): boolean {
  return LEGACY_CODE_MODE_SURFACES.has(surface);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const legacyToolPolicySchema = z.object({
  allowlist: z.array(z.string().min(1)).optional(),
  riskCeiling: z.enum(["low", "medium", "high"]).optional(),
});

/**
 * `content` is opaque on purpose. The `ai` SDK's `ModelMessage.content` is a
 * union of string | content-part arrays whose exact shape this contract has no
 * reason to duplicate — the engine is the thing that interprets it.
 * `.passthrough()` keeps whatever shape the SDK actually produced instead of
 * stripping fields this schema does not model.
 */
const legacyHistoryMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.unknown(),
  })
  .passthrough();

/**
 * Non-strict on purpose: unknown keys are STRIPPED, not rejected, so an
 * additive field written by a newer enqueuing build does not fail an otherwise
 * valid legacy row on the claim side. The `version` literal is the real
 * compatibility gate — `parseRunSpecV1` checks it explicitly, first, with its
 * own message.
 */
export const runSpecV1Schema = z.object({
  version: z.literal(LEGACY_RUN_SPEC_VERSION),
  instruction: z.string().min(1, "instruction must not be empty"),
  model: z.string().min(1).optional(),
  history: z.array(legacyHistoryMessageSchema).optional(),
  toolPolicy: legacyToolPolicySchema.optional(),
});

export type RunSpecV1 = z.infer<typeof runSpecV1Schema>;
export type LegacyToolPolicy = z.infer<typeof legacyToolPolicySchema>;

/**
 * Validate a claimed legacy run's `spec`.
 *
 * Throws a plain `Error` with a human-readable message on ANY failure —
 * including an unrecognized `version` — because a thrown driver error is
 * exactly what the worker harness turns into `failRun`'s message
 * (`packages/agent-worker/src/terminal.ts`'s `decideTerminalAction`). It
 * deliberately does NOT throw `RunSpecValidationError`: that type belongs to
 * the trusted v2 admission path, and a legacy parse failure must not be
 * mistaken for a governed-admission rejection in logs or metrics.
 *
 * A `version: 2` spec fails here, loudly. The v1 driver has no fenced attempt
 * IO, so executing a v2 row through it would append unfenced events to a run
 * whose evidence chain expects an attempt — the failure is the point.
 */
export function parseRunSpecV1(raw: unknown): RunSpecV1 {
  if (raw === null || typeof raw !== "object") {
    throw new Error(
      `RunSpec validation failed: expected an object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== LEGACY_RUN_SPEC_VERSION) {
    throw new Error(
      `RunSpec validation failed: unsupported version ${JSON.stringify(version)} — this driver only understands RunSpec v1`,
    );
  }
  const parsed = runSpecV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`RunSpec validation failed: ${issues}`);
  }
  return parsed.data;
}

/** The caller-supplied half of a legacy admission — everything v1 ever had. */
export interface LegacyRunSpecV1Input {
  instruction: string;
  model?: string;
  toolPolicy?: LegacyToolPolicy;
}

/**
 * Build the exact spec JSON a legacy admission persists to
 * `agent.agent_runs.spec`.
 *
 * Optional keys are OMITTED rather than written as `undefined`: the enqueued
 * JSON is compared byte-for-byte by the route tests and `JSON.stringify` drops
 * `undefined` values silently, which would make an accidental `model: undefined`
 * indistinguishable from a deliberate omission at the SQL boundary.
 */
export function buildLegacyRunSpecV1(input: LegacyRunSpecV1Input): RunSpecV1 {
  return {
    version: LEGACY_RUN_SPEC_VERSION,
    instruction: input.instruction,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
  };
}
