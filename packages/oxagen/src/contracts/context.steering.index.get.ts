/**
 * `get_steering_index`: the workspace's published record index and what
 * Oxagen knows outside the steering repo, for `oxagen check` (#4555).
 *
 * `oxagen check` runs the steering PR checks on a clone before you push. Two
 * of them read more than the tree. The hash and conflicts checks compare the
 * steering PR with the records the workspace has published. The references
 * check resolves each runtime, operator, reviewer group, and credential the
 * repo names against what Oxagen holds. This read returns both in one answer.
 *
 * `index` is null until the workspace publishes its first version. Each
 * record carries the fields the checks read, and no statement: `bundle/v1`
 * keeps a record's body in the repository, not in the version.
 *
 * `context` holds five lists of names. A list with no table behind it yet
 * comes back empty, and the references check then reports every name of that
 * kind as missing. The handler says which lists those are.
 *
 * The shapes match `IndexRecord` and `CheckContext` in `@oxagen/steering-check`
 * field for field. They are written out here because this package cannot
 * import that one: steering-check reads the steering-repo schemas from here.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** One published record: the part of a `bundle/v1` record the checks read. */
export const steeringIndexRecordSchema = z
  .object({
    lineage: z.string().min(1),
    path: z.string().min(1),
    id: z.string().min(1),
    hash: z.string().min(1),
    kind: z.string().min(1),
    /** `require` or `forbid` for a constraint, null for any other kind. */
    effect: z.string().nullable().optional(),
    /** The record's statement. `bundle/v1` has none, so this read never sets it. */
    statement: z.string().nullable().optional(),
  })
  .strict();

/** What Oxagen knows outside the steering repo. Each list is sorted. */
export const steeringCheckContextSchema = z
  .object({
    /** Runtime slugs enrolled in the workspace. */
    runtimes: z.array(z.string()),
    /** The organization's members by public user id (`usr_…`), which an agent file names as its operator (ADR-265). */
    members: z.array(z.string()),
    /** Team slugs in the organization. */
    teams: z.array(z.string()),
    /** Reviewer group slugs in the organization. */
    groups: z.array(z.string()),
    /** Credential names in the workspace's vault. */
    credentials: z.array(z.string()),
  })
  .strict();

export const steeringIndexGet = registerCapability({
  name: "get_steering_index",
  domain: "context",
  description:
    "Read the workspace's published steering record index and the runtimes, members, teams, reviewer groups, and credentials Oxagen holds, so oxagen check can run the steering PR checks on a clone.",
  mode: "sync",
  surfaces: ["api", "cli"],
  layers: ["schema", "api", "cli", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      /** The published version's records, or null before the first publish. */
      index: z
        .object({ records: z.array(steeringIndexRecordSchema) })
        .strict()
        .nullable(),
      context: steeringCheckContextSchema,
    })
    .strict(),
});

export type SteeringIndexRecord = z.output<typeof steeringIndexRecordSchema>;
export type SteeringCheckContext = z.output<typeof steeringCheckContextSchema>;
export type SteeringIndexGetOutput = z.output<typeof steeringIndexGet.output>;
