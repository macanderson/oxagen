import { z } from "zod";
import { defineTool } from "./_define";
import { contextRecordPublish } from "../context.record.publish";

const publishIn = contextRecordPublish.input.shape;
const publishOut = contextRecordPublish.output.shape;

/**
 * Appendix E: `open_context_pr` — "the pull request". Absorbs
 * `publish_context_record`.
 *
 * **The absorbed contract already did the hard half; what changes is where it
 * lands.** `publish_context_record` upserted a registry row and froze an
 * immutable version when the canonical body changed, idempotently on an
 * unchanged checksum. All of that carries by import, unaltered — it is the same
 * versioning discipline §10.3's checks depend on.
 *
 * What does not carry is the implication that publishing *is* this call. §10
 * is unambiguous: "Merge is the promotion event. Nothing steers until it is
 * published. The graph is the system of record. Git is the system of control."
 * So this tool opens a branch and a pull request (§10.3 step 1), and merge —
 * observed by the GitHub App — is what writes the `promotion_event`, bumps the
 * bundle version and emits `steering_published`. The version row this call
 * creates is a proposal in the registry, not live steering.
 *
 * **The target repo is chosen, not assumed.** §10.3 step 1: "The target is the
 * main repo for workspace-scoped records and the linked repo for
 * repository-scoped ones." That makes `sharingScope` required input rather than
 * a property discovered later, because it decides which repository the branch
 * is even cut on.
 *
 * **The agent surface is added deliberately.** `publish_context_record` was
 * `["api"]` only. §7 lists the in-app agent's tools and ends the list with
 * "and open a Context PR", so Appendix E putting this on the belt is the spec
 * agreeing with itself. The `requiresApproval: true` posture carries unchanged,
 * and §10.3's review modes are a second gate after that.
 */
export const openContextPr = defineTool({
  name: "open_context_pr",
  domain: "context",
  description:
    "Open a Context PR proposing a steering record: cut a context/<lineage> branch on the repo the sharing scope selects, write the record file, and open the pull request with its rationale and supporting record ids. Merge is what publishes it (§10.3).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "docs", "unit"],
  scoped: true,
  // Carried: opening a Context PR is governance and spends no model tokens.
  noBillingGate: true,

  absorbs: ["publish_context_record"],
  drops: [
    {
      field: "record_id",
      from: "publish_context_record",
      why: "v1 keyed on the `.stella/rules/<record_id>.toml` file stem. §10.2 publishes 'one published record per lineage id' as `ctx.<set>.<slug>.toml` under `.oxagen/`, so the lineage is the key and the file name is derived from it — keeping a separate stem would let the two disagree about which file a lineage owns",
    },
  ],

  // Carried unchanged from the single source. The approval matters: this is the
  // call that puts a change in front of §10.3's review, and in `regulated` mode
  // a named approver has to sign for it.
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  // v1 also spelled a workspace `Admin` grant, which `SystemWorkspaceRole`
  // (Owner | Member | Viewer) does not have — it granted nothing, so it is
  // dropped rather than reproduced.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes the registry version row and creates a branch, a commit and a pull
  // request through the GitHub App.
  mutates: true,

  input: z.object({
    /**
     * §10.3 step 1 names the branch `context/<lineage>`, and §10.2 publishes
     * one record per lineage id. Replaces v1's `record_id`.
     */
    lineageId: z
      .string()
      .min(1)
      .describe("Names the branch (context/<lineage>) and the record file"),

    // Carried by reference.
    title: publishIn.title,
    body: publishIn.body,

    /**
     * Carried whole, including its note that entries reuse the
     * ContextProvenanceV1 field vocabulary rather than inventing a parallel
     * shape. §10.3 step 2's checks recompute `record_hash` and scan for secrets
     * and PII over exactly this.
     */
    provenance: publishIn.provenance,

    /**
     * Required, because §10.3 step 1 picks the target repository from it: the
     * main repo for workspace-scoped records, the linked repo for
     * repository-scoped ones. Defaulting it would silently open PRs on the
     * wrong repo for every repository-scoped record.
     */
    sharingScope: z
      .enum(["workspace", "repository"])
      .describe("Selects the target repo: main for workspace, linked for repository"),

    /**
     * Set when a repository-scoped record is being published — §10.2: "Each may
     * carry its own `.oxagen/rules/` holding records with
     * `sharing_scope = "repository"`. Those records steer only runs on that
     * repo."
     */
    repoId: z
      .string()
      .min(1)
      .optional()
      .describe("The linked repo to target; required when scope is repository"),

    /**
     * §10.3 step 1: "The PR body carries the rationale, the supporting record
     * ids, evidence links, and an Oxagen check-run link." The first two come
     * from the proposal; they are inputs rather than lookups so a Context PR
     * opened by hand carries the same body as one opened by the promoter.
     */
    rationale: z.string().min(1).max(4000),
    supportingRecordIds: z.array(z.string().min(1)).max(50).default([]),
  }),

  output: z.object({
    // The registry side, carried whole. `published` keeps its v1 meaning — a
    // new immutable version row was created, false when the latest already
    // carries this checksum — which is still the right idempotency answer.
    publicId: publishOut.publicId,
    recordId: publishOut.recordId,
    version: publishOut.version,
    checksum: publishOut.checksum,
    published: publishOut.published,

    /** §10.3 step 1's branch, named for the lineage. */
    branch: z.string(),

    /** The pull request itself. Merging it is the promotion event (§10). */
    prUrl: z.string().url(),

    /**
     * §10.3 step 1 requires the PR body to carry a check-run link, and step 2's
     * checks (schema, lineage uniqueness, `record_hash` recomputation, the
     * secret and PII scan, conflicts against active records, truth probes) are
     * what decide whether the PR is mergeable at all. Returned so the caller
     * can watch them without scraping the PR body.
     */
    checkRunUrl: z.string().url(),

    /**
     * §10.3 step 3: solo mode lets the author merge, team mode requires a
     * code-owner review, regulated mode requires a named approver from a role.
     * The caller needs to know which gate it is waiting on, and the mode is a
     * workspace setting it may not have read.
     */
    reviewMode: z.enum(["solo", "team", "regulated"]),
  }),
});

export type OpenContextPrInput = z.output<typeof openContextPr.input>;
export type OpenContextPrOutput = z.output<typeof openContextPr.output>;
