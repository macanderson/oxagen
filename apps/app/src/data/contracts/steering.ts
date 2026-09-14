// Steering: published context records, proposals, effect and retirement
// (spec §9–§10). Record vocabulary follows Stella's context-record format.
import { z } from "zod";
import { CommitSha, Count, Day, PublicId, Ratio, RecordKind } from "./common";

/** A lineage id: the record's stable dotted name (`ctx.release.notes-format`). */
export const LineageId = z.string().regex(/^ctx(\.[a-z0-9-]+)+$/);
export type LineageId = z.infer<typeof LineageId>;

export const RecordForce = z.enum(["must", "should", "may", "info"]);
export type RecordForce = z.infer<typeof RecordForce>;

export const SteeringRecord = z.object({
  lineage: LineageId,
  kind: RecordKind,
  force: RecordForce,
  /** Constraint enforcement, where the record carries one. */
  enforcement: z.enum(["require", "forbid"]).nullable(),
  scope: z.enum(["workspace", "repository"]),
  status: z.enum(["published", "archived"]),
  statement: z.string(),
  /** Measured effect. Null until effect metrics are recorded (M3); `records` is wired at M0. */
  effect: z
    .object({ rendered: Count, cited: Count, violated: Count })
    .nullable(),
  commitSha: CommitSha,
  publishedOn: Day,
});
export type SteeringRecord = z.infer<typeof SteeringRecord>;

export const SteeringProposal = z.object({
  id: PublicId,
  lineage: LineageId,
  kind: RecordKind,
  force: RecordForce,
  /** What proposed it: the findings job, the reflector, or a person. */
  source: z.object({
    kind: z.enum(["findings_job", "reflector", "person"]),
    ref: z.string(),
  }),
  statement: z.string(),
  support: z.string(),
  state: z.enum(["candidate", "open_context_pr"]),
  pullRequestRef: z.string().nullable(),
  checks: z
    .object({ passed: Count, total: Count, running: z.boolean() })
    .nullable(),
});
export type SteeringProposal = z.infer<typeof SteeringProposal>;

/** Measured effect of one published record (M3 effect metrics). */
export const RecordEffect = z.object({
  lineage: LineageId,
  kind: RecordKind,
  rendered: Count,
  cited: Count,
  violated: Count,
  proofRateBefore: Ratio.nullable(),
  proofRateAfter: Ratio.nullable(),
  recommendation: z.enum(["keep", "watch", "retire"]),
});
export type RecordEffect = z.infer<typeof RecordEffect>;

export const RetirementCandidate = z.object({
  lineage: LineageId,
  kind: RecordKind,
  publishedOn: Day,
  rendered: Count,
  cited: Count,
  reason: z.string(),
  archivedOn: Day.nullable(),
});
export type RetirementCandidate = z.infer<typeof RetirementCandidate>;
