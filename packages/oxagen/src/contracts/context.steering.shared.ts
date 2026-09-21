// context.steering.shared.ts — the vocabulary the steering contracts share
// (ADR-061; MC spec §9, §10). Not a capability: exported through the barrel so
// the contracts file-coverage guard sees it, like spend.shared.ts.
import { z } from "zod";

/** The six kinds of context-record/v0.1, Stella's file surface (spec §10.2). */
export const recordKindSchema = z.enum([
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
]);
export type RecordKind = z.infer<typeof recordKindSchema>;

/** How hard a record steers (spec §10.4: must/should ride the stable prefix). */
export const recordForceSchema = z.enum(["must", "should", "may", "info"]);
export type RecordForce = z.infer<typeof recordForceSchema>;

/**
 * A constraint's effect. `allow` is unrepresentable on purpose: a record can
 * never grant authority (spec §10.3 check 6).
 */
export const constraintEffectSchema = z.enum(["require", "forbid"]);
export type ConstraintEffect = z.infer<typeof constraintEffectSchema>;

/**
 * Where a record applies (spec §10.2): a workspace record lives in the main
 * repo and steers every run; a repository record lives in a linked repo and
 * steers runs on that repo. An append carries the same two scopes: they are
 * the ones every read enforces through the workspace the caller is in (spec
 * §9 Scope). The protocol's `user` and `organization` keys have no read path
 * here and are refused at the schema.
 */
export const publishedSharingScopeSchema = z.enum(["repository", "workspace"]);
export type PublishedSharingScope = z.infer<typeof publishedSharingScopeSchema>;

/** The kinds an agent may append through `context/append` (spec §9). */
export const appendKindSchema = z.enum([
  "observation",
  "memory",
  "knowledge",
  "evidence",
  "record_proposal",
  "context_use",
  "context_use_feedback",
]);
export type AppendKind = z.infer<typeof appendKindSchema>;

/**
 * The proposal's state machine (spec §10.3). `checks_failed` is the state a
 * failed §10.3 check leaves the PR in; a re-run through open_context_pr moves
 * it back to `checks_running`. `rejected` is dismiss_proposal's terminal state.
 */
export const proposalStatusSchema = z.enum([
  "proposed",
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
  "merged",
  "rejected",
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const governanceModeSchema = z.enum(["solo", "team", "regulated"]);
export type GovernanceMode = z.infer<typeof governanceModeSchema>;

/** The modes in the order every surface offers them: loosest to strictest. */
export const GOVERNANCE_MODES = governanceModeSchema.options;

/**
 * `.oxagen/rules/governance.toml` for a mode.
 *
 * One copy, because every producer of this file has to agree with the one
 * parser of it (`parseGovernanceMode`): `open_init_pr` refuses a draft whose
 * declared mode differs from the mode chosen, and `set_governance_mode`
 * commits this text straight to a production branch, where the next
 * `open_context_pr` reads it back. It lived twice — the init wizard
 * (apps/app) and `oxagen repo init` (apps/cli) held byte-identical copies —
 * and a third copy in the handler is what moved it here instead.
 *
 * It belongs in the contracts rather than in a handler because the app and
 * the CLI both draft the text for a person to read BEFORE any capability is
 * called, and neither may import a handler.
 */
export function draftGovernanceToml(mode: GovernanceMode): string {
  return [
    "# Read on the production branch when a pull request is opened and again",
    "# when it is merged. A missing file means team.",
    `mode = "${mode}"`,
    `separation_of_duties = ${mode === "regulated" ? "true" : "false"}`,
    "",
  ].join("\n");
}

/** The six §10.3 checks, in the order they run. */
export const checkNameSchema = z.enum([
  "schema",
  "lineage_uniqueness",
  "record_hash",
  "secret_pii_scan",
  "conflict_against_active",
  "constraint_effect",
]);
export type CheckName = z.infer<typeof checkNameSchema>;
export const CHECK_NAMES = checkNameSchema.options;

const instant = z.string().datetime({ offset: true });

/** One check's recorded outcome, as stored on the proposal and mirrored to GitHub. */
export const checkResultSchema = z
  .object({
    name: checkNameSchema,
    status: z.enum(["pending", "running", "passed", "failed"]),
    /** One line of what was checked and what was found; empty while pending. */
    summary: z.string(),
    /** The GitHub check run, when the App could create one; null otherwise. */
    detailsUrl: z.string().nullable(),
    startedAt: instant.nullable(),
    completedAt: instant.nullable(),
  })
  .strict();
export type CheckResult = z.infer<typeof checkResultSchema>;

const lineageId = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
    "a lineage id is lowercase letters, digits, dots and hyphens (e.g. ctx.release.notes-format)",
  );

/** The record a proposal asks to publish. */
export const proposedRecordSchema = z
  .object({
    lineageId: lineageId.describe(
      "The lineage this proposal is about; the file stem under .oxagen/rules/",
    ),
    kind: recordKindSchema,
    force: recordForceSchema,
    /** Required on a constraint, refused on every other kind. */
    constraintEffect: constraintEffectSchema.optional(),
    sharingScope: publishedSharingScopeSchema.describe(
      "Decides which repo the Context PR targets (spec §10.3 step 1)",
    ),
    statement: z
      .string()
      .min(1)
      .max(2000)
      .describe("The single-sentence claim"),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind === "constraint" && r.constraintEffect === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["constraintEffect"],
        message: "a constraint declares require or forbid",
      });
    }
    if (r.kind !== "constraint" && r.constraintEffect !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["constraintEffect"],
        message: "only a constraint carries an effect",
      });
    }
  });

/** The support a proposal cites (spec §9.2). */
export const proposalSupportSchema = z
  .object({
    /** Sealed runs whose evidence supports the proposal (run public ids). */
    runs: z.array(z.string().min(1).max(64)).max(500).default([]),
    /** Distinct agents among those runs (agent keys). */
    agents: z.array(z.string().min(1).max(128)).max(100).default([]),
    /** Appended records the proposal cites (`cta_…` or protocol `rec_…` ids). */
    recordIds: z.array(z.string().min(1).max(128)).max(50).default([]),
    /** Frames (`frame:<run>/<seq>`), tool outputs by digest, or findings. */
    evidenceLinks: z.array(z.string().min(1).max(512)).max(100).default([]),
  })
  .strict();

/** A proposal as the page lists it. */
export const proposalViewSchema = z
  .object({
    id: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    lineageId: z.string(),
    kind: recordKindSchema,
    force: recordForceSchema,
    constraintEffect: constraintEffectSchema.nullable(),
    sharingScope: publishedSharingScopeSchema,
    statement: z.string(),
    rationale: z.string(),
    source: z.string(),
    support: z
      .object({
        runs: z.array(z.string()),
        agents: z.array(z.string()),
        recordIds: z.array(z.string()),
        evidenceLinks: z.array(z.string()),
      })
      .strict(),
    status: proposalStatusSchema,
    pr: z
      .object({
        number: z.number().int().positive(),
        url: z.string(),
        repository: z.string(),
        branch: z.string(),
      })
      .strict()
      .nullable(),
    /** passed / total of the six checks; null before the PR is opened. */
    checks: z
      .object({ passed: z.number().int(), total: z.number().int() })
      .strict()
      .nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();
export type ProposalView = z.infer<typeof proposalViewSchema>;

/** A published record as the page lists it. */
export const publishedRecordSchema = z
  .object({
    id: z.string().regex(/^ctr_[0-9A-Za-z]+$/),
    lineageId: z.string(),
    title: z.string(),
    /**
     * Every write path has required agent.context_records.kind since #3302,
     * but the DB-level NOT NULL is a deliberate follow-up migration (see
     * `20260920150000`'s comment) rather than shipped with the write
     * requirement itself, so a genuinely unclassified row can still exist.
     * Nullable here for that reason, and because
     * context_record_versions.kind still is (a legacy version
     * merge_context_pr never wrote): a record's active version can, in
     * principle, be one of those on a database this old.
     */
    kind: recordKindSchema.nullable(),
    force: recordForceSchema.nullable(),
    constraintEffect: constraintEffectSchema.nullable(),
    sharingScope: publishedSharingScopeSchema,
    statement: z.string().nullable(),
    status: z.enum(["active", "retired", "superseded"]),
    version: z.number().int().nullable(),
    checksum: z.string().nullable(),
    /** The merge commit that published it; null when no Context PR did. */
    commit: z.string().nullable(),
    /** The file's path in the repository; null when no Context PR wrote it. */
    path: z.string().nullable(),
    publishedAt: instant.nullable(),
    updatedAt: instant,
  })
  .strict();
export type PublishedRecordView = z.infer<typeof publishedRecordSchema>;
