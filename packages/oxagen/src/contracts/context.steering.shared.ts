// context.steering.shared.ts — the vocabulary the steering contracts share
// (ADR-061; MC spec §9, §10). Not a capability: exported through the barrel so
// the contracts file-coverage guard sees it, like spend.shared.ts.
import { z } from "zod";
import {
  STEERING_RECORD_LABEL_MAX,
  STEERING_RECORD_LINEAGE,
} from "../steering-record-label";

/** The six kinds of a v0.1 record file, Stella's file surface (spec §10.2). */
export const recordKindSchema = z.enum([
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
]);
export type RecordKind = z.infer<typeof recordKindSchema>;

/**
 * The steering PRs Oxagen opens that change files rather than one record
 * (#5122, ADR-265). Each one carries a proposal row of its kind, so
 * merge_steering_pr lands it through the merge queue like a record PR.
 *
 * - `revert`: the PR revert_steering_pr opens to undo a merged steering PR.
 * - `tools`: a tools/ PR from Studio's Review, the server sync (M10), or the
 *   server folder writer (M13).
 * - `import`: an import's PR (see below).
 * - `memory_pr`: the memory PR on memory/<date>, from the curator or from a
 *   person promoting memories. `memory` alone is the record kind.
 * - `agent_file`: the PR that adds agents/<name>.toml when a host enrolls (#5149).
 * - `agent_proposal`: the PR an agent opens with propose_steering (#5134).
 * - `workspace`: the PR link_repository or unlink_repository opens to change
 *   which code repositories workspace.toml lists.
 *
 * `import` covers both imports: the Markdown import's PR, and each PR
 * import_workspace_steering opens when it moves `.oxagen/` to a steering repo.
 */
export const steeringPrKindSchema = z.enum([
  "revert",
  "tools",
  "import",
  "memory_pr",
  "agent_file",
  "agent_proposal",
  "workspace",
]);
export type SteeringPrKind = z.infer<typeof steeringPrKindSchema>;

/**
 * What a proposal asks to change: a record of one of the six kinds, the
 * steering repository's governance mode (#4795), or the files of one steering
 * PR (#5122). A governance proposal is the review-route PR
 * `set_governance_mode` opens on `steering/governance`. It changes
 * `steering/governance.toml` and publishes no record. A steering PR proposal
 * publishes no single record either. Every reader of a record keeps
 * `RecordKind`, and `isRecordKind` tells a record proposal from the rest.
 */
export const proposalKindSchema = z.enum([
  ...recordKindSchema.options,
  "governance",
  ...steeringPrKindSchema.options,
]);
export type ProposalKind = z.infer<typeof proposalKindSchema>;

const RECORD_KINDS: ReadonlySet<string> = new Set(recordKindSchema.options);
const STEERING_PR_KINDS: ReadonlySet<string> = new Set(
  steeringPrKindSchema.options,
);

/** True for a proposal that publishes one record: one of the six record kinds. */
export function isRecordKind(kind: string): kind is RecordKind {
  return RECORD_KINDS.has(kind);
}

/** True for a proposal that carries a steering PR's files rather than one record. */
export function isSteeringPrKind(kind: string): kind is SteeringPrKind {
  return STEERING_PR_KINDS.has(kind);
}

/**
 * The lineage every governance proposal shares. The open-PR index allows one
 * open PR per lineage, so a workspace has at most one governance PR open.
 */
export const GOVERNANCE_LINEAGE = "governance";

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
 * failed §10.3 check leaves the PR in; a re-run through open_steering_pr moves
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

/**
 * The three states a person filters proposals by, as a pull request list
 * names them. `open` is every proposal a person can still act on: a candidate
 * with no pull request yet, and a steering PR still open on the host. `closed`
 * is a dismissal, from Oxagen or from the host closing the pull request.
 */
export const proposalStateSchema = z.enum(["open", "merged", "closed"]);
export type ProposalState = z.infer<typeof proposalStateSchema>;

/** The statuses each state holds. Every status sits in exactly one state. */
export const PROPOSAL_STATE_STATUSES: Readonly<
  Record<ProposalState, readonly ProposalStatus[]>
> = {
  open: [
    "proposed",
    "pr_open",
    "checks_running",
    "checks_passed",
    "checks_failed",
  ],
  merged: ["merged"],
  closed: ["rejected"],
};

/** The state a status sits in. */
export function proposalStateOf(status: ProposalStatus): ProposalState {
  return status === "merged"
    ? "merged"
    : status === "rejected"
      ? "closed"
      : "open";
}

/**
 * The repository hosts steering publishes through (#3762). A steering PR on
 * GitLab is a merge request; its number is the merge request's IID.
 */
export const repositoryProviderSchema = z.enum(["github", "gitlab"]);
export type RepositoryProvider = z.infer<typeof repositoryProviderSchema>;

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
 * `open_steering_pr` reads it back. It lived twice — the init wizard
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

/**
 * The eleven checks a steering PR runs, in the order they run
 * (steering-repo-spec, Steering PR flow). `@oxagen/steering-check` runs them
 * for the server and the CLI. The six names above stay for the v0.1 steering
 * PR until lane S10 moves every workspace.
 */
export const steeringCheckNameSchema = z.enum([
  "schema",
  "lineage",
  "hash",
  "secrets",
  "conflicts",
  "authority",
  "settings",
  "references",
  "budget",
  "compile",
  "owned",
]);
export type SteeringCheckName = z.infer<typeof steeringCheckNameSchema>;
export const STEERING_CHECK_NAMES = steeringCheckNameSchema.options;

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

/**
 * One finding the latest check run left on a steering PR's head, beyond the
 * six outcomes (#4518, ADR-267). `managed-block` is the one rule today: the
 * PR changes the managed block Oxagen writes in AGENTS.md, CLAUDE.md, or
 * README.md, and restore_managed_block puts it back.
 */
export const checkFindingSchema = z
  .object({
    rule: z.enum(["managed-block"]),
    /** The file the finding is in. */
    path: z.string(),
    /** The line it starts on, when the check could name one. */
    line: z.number().int().positive().nullable(),
    /** One sentence saying what the check found. */
    message: z.string(),
  })
  .strict();
export type CheckFinding = z.infer<typeof checkFindingSchema>;

/** A lineage id: the file stem under .oxagen/rules/. Shared with handlers that read an id from input. */
/**
 * A record's lineage id, with `governance` held back. Every governance
 * proposal holds that lineage, and the open-PR index keys on it, so a record
 * on it would share the one governance PR slot (#4795). The lookahead keeps
 * the rule in the one pattern, so the field keeps a plain string schema and
 * its description.
 */
const RECORD_LINEAGE_ID = new RegExp(
  `^(?!${GOVERNANCE_LINEAGE}$)${STEERING_RECORD_LINEAGE.source.replace(/^\^/, "")}`,
);

export const lineageIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    RECORD_LINEAGE_ID,
    `a lineage id is lowercase letters, digits, dots and hyphens (e.g. ctx.release.notes-format). The id ${GOVERNANCE_LINEAGE} is reserved for governance changes`,
  );

/** The record a proposal asks to publish. */
export const proposedRecordSchema = z
  .object({
    lineageId: lineageIdSchema.describe(
      "The lineage this proposal is about; the file stem under .oxagen/rules/",
    ),
    title: z.string().trim().min(1).max(200).optional(),
    label: z
      .string()
      .trim()
      .min(1)
      .max(STEERING_RECORD_LABEL_MAX)
      .optional()
      .describe(
        "The record's name, at most 36 characters. Omit it to keep the current label. A rename never creates a version and never changes the lineage.",
      ),
    kind: recordKindSchema,
    force: recordForceSchema,
    /** Required on a constraint, refused on every other kind. */
    constraintEffect: constraintEffectSchema.optional(),
    sharingScope: publishedSharingScopeSchema.describe(
      "Decides which repo the steering PR targets (spec §10.3 step 1)",
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
    kind: proposalKindSchema,
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
        /** Which host issued `number`: a pull request or a merge request IID. */
        provider: repositoryProviderSchema,
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
    label: z.string().optional(),
    /**
     * Every write path has required agent.steering_records.kind since #3302,
     * but the DB-level NOT NULL is a deliberate follow-up migration (see
     * `20260920150000`'s comment) rather than shipped with the write
     * requirement itself, so a genuinely unclassified row can still exist.
     * Nullable here for that reason, and because
     * steering_record_versions.kind still is (a legacy version
     * merge_steering_pr never wrote): a record's active version can, in
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
    /** The merge commit that published it; null when no steering PR did. */
    commit: z.string().nullable(),
    /** The file's path in the repository; null when no steering PR wrote it. */
    path: z.string().nullable(),
    publishedAt: instant.nullable(),
    updatedAt: instant,
  })
  .strict();
export type PublishedRecordView = z.infer<typeof publishedRecordSchema>;
