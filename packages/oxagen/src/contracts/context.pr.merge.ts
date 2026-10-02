// merge_context_pr — merge is the publication (ADR-061; MC spec §10.3 steps
// 3-4). Refused until every check passed; the reviewer the governance mode
// names must be the caller (solo: any workspace member, the author included;
// team: an Owner or Admin other than the author; regulated: an org Owner or
// Admin other than the author, recorded as the accountable approver). On
// merge the handler publishes the record into the registry, appends the
// promotion event to the hash-chained ledger, and emits `steering.published`.
// A governance proposal (#4795) publishes no record and appends no promotion
// event: it lands `steering/governance.toml`, names the approver on the
// ledger line and the proposal, and emits `steering.governance_changed`. A
// steering PR proposal (#5122, ADR-265) lands its PR's files, publishes the
// steering version, retires the records a revert deleted, and emits
// `steering.published`. The output is a union on `kind`.
// The reviewer is a signed-in user; an API key carries no user, so the MCP
// surface (API-key auth) is not declared.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  governanceModeSchema,
  recordKindSchema,
  steeringPrKindSchema,
} from "./context.steering.shared";

/**
 * The number of entries in the workspace's promotion ledger before and after
 * this merge. It counts merged records, not steering versions: a steering
 * repo's first commit is version 1 and appends no ledger entry, so the two
 * numbers differ there. A governance merge appends none, so its two numbers
 * are equal. `publishedVersion` is the steering version (#4732).
 */
const bundleVersionSchema = z
  .object({ before: z.number().int(), after: z.number().int() })
  .strict();

/**
 * The steering version this merge published, the number in its
 * Oxagen-Version trailer. Null in a legacy repository, which has no version
 * store, and null when publish() did not make the version live: the
 * repository sync then publishes the production branch.
 */
const publishedVersionSchema = z.number().int().positive().nullable();

/** A record proposal's merge: the record it published and its ledger entry. */
const recordMergeSchema = z
  .object({
    proposalId: z.string(),
    status: z.literal("merged"),
    kind: recordKindSchema,
    record: z
      .object({
        id: z.string(),
        lineageId: z.string(),
        version: z.number().int().positive(),
        path: z.string(),
      })
      .strict(),
    mergedCommit: z.string(),
    promotionEvent: z
      .object({
        id: z.string(),
        seq: z.number().int().positive(),
        chainDigest: z.string(),
      })
      .strict(),
    bundleVersion: bundleVersionSchema,
    publishedVersion: publishedVersionSchema,
  })
  .strict();

/** A governance proposal's merge: the mode it put in force and the file. */
const governanceMergeSchema = z
  .object({
    proposalId: z.string(),
    status: z.literal("merged"),
    kind: z.literal("governance"),
    governance: z
      .object({
        /** The mode `steering/governance.toml` declares at the merge commit. */
        mode: governanceModeSchema,
        path: z.string(),
      })
      .strict(),
    mergedCommit: z.string(),
    bundleVersion: bundleVersionSchema,
    publishedVersion: publishedVersionSchema,
  })
  .strict();

/**
 * A steering PR proposal's merge (#5122, ADR-265): a revert, tools, import,
 * memory, agent file, agent proposal, or workspace settings PR. It publishes no single record, so
 * it names the pull request and the records a revert retired.
 */
const steeringPrMergeSchema = z
  .object({
    proposalId: z.string(),
    status: z.literal("merged"),
    kind: steeringPrKindSchema,
    pullRequest: z
      .object({ number: z.number().int().positive(), branch: z.string() })
      .strict(),
    /**
     * The lineages of the registry records this merge retired: a revert whose
     * merge deleted the file of a record a Context PR published. Empty for
     * every other merge.
     */
    retired: z.array(z.string()),
    mergedCommit: z.string(),
    bundleVersion: bundleVersionSchema,
    publishedVersion: publishedVersionSchema,
  })
  .strict();

/** The output merge_context_pr and merge_pr_without_review share. */
export const contextPrMergeOutputSchema = z.discriminatedUnion("kind", [
  recordMergeSchema,
  governanceMergeSchema,
  steeringPrMergeSchema,
]);

export const contextPrMerge = registerCapability({
  name: "merge_context_pr",
  domain: "context",
  description:
    "Merge a proposal's steering PR (a GitHub pull request or a GitLab merge request) through the merge queue: refused until every check passed and unless the caller is a reviewer the governance mode allows. A record proposal publishes its record and writes the promotion event to the ledger. A revert, tools, import, memory, agent, or workspace settings PR lands its files, and a revert retires each record whose file it deleted. Bumps the steering version and emits steering.published",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: contextPrMergeOutputSchema,
});

export type ContextPrMergeInput = z.output<typeof contextPrMerge.input>;
export type ContextPrMergeOutput = z.output<typeof contextPrMerge.output>;
