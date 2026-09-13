import { z } from "zod";
import { defineTool } from "./_define";
import { schemaRecommend } from "../schema.recommend";
import { schemaSetup } from "../schema.setup";
import { schemaVersionCreate } from "../schema.version.create";
import { schemaChat } from "../schema.chat";
import { schemaVersionPin } from "../schema.version.pin";
import { schemaToggle } from "../schema.toggle";
import { schemaReconcileDispatch } from "../schema.reconcile.dispatch";

/**
 * Appendix E: `propose_ontology_version` — "profiler plus author; opens the pull
 * request on the main repo (merge activates, §11.8)". Absorbs
 * `recommend_schema`, `setup_schema`, `create_schema_version`,
 * `run_schema_chat`, `pin_schema_version`, `toggle_schema` and
 * `dispatch_schema_reconcile`.
 *
 * Seven sources, and §11.8 removes the thing five of them acted on. "The
 * registry stops being a Postgres store. It becomes the loader, validator,
 * differ, and pin logic over files in the main repo." And §11.2 step 4: "Merge
 * is activation… Nothing activates any other way."
 *
 * So every verb that used to change live state becomes content of a proposal:
 *
 * | v1 verb | what it is now |
 * |---|---|
 * | `create_schema_version` freeze a draft | the branch; a version number is assigned by the merged manifest |
 * | `pin_schema_version` move the pin | the merge moves it |
 * | `toggle_schema` enable/disable | `enabled` flags in `manifest.json` on the branch |
 * | `dispatch_schema_reconcile` relabel the graph | the migration plan in the PR body; activation runs it |
 * | `setup_schema` walk the registry | this tool, end to end |
 *
 * What survives as input is what a proposal actually needs: how deep to profile,
 * what the author wants changed, and what the PR should say.
 *
 * **The sensitivity call a reviewer should check.** `dispatch_schema_reconcile`
 * is `destructive` (it prunes graph nodes and relationships) and that is the
 * strictest of the seven — but it does not carry. This tool opens a pull
 * request; it relabels nothing. The destruction moved to merge-time activation
 * (§11.2 step 4), which no agent tool performs. Carrying `destructive` here
 * would mis-grade the one action in this family that a reviewer can still veto,
 * and would leave the actually-destructive step ungraded because it has no tool.
 * `high` carries instead, from `pin_schema_version` and `toggle_schema`. The
 * same reasoning drops `dispatch_schema_reconcile`'s `high` riskLevel to the
 * `medium` those two declare.
 */
export const proposeOntologyVersion = defineTool({
  name: "propose_ontology_version",
  domain: "schema",
  description:
    "Profile the workspace's sources, author an ontology change, and open it as a pull request on the main repo against .oxagen/ontology/. Merge is activation (§11.8); this tool activates nothing.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: [
    "recommend_schema",
    "setup_schema",
    "create_schema_version",
    "run_schema_chat",
    "pin_schema_version",
    "toggle_schema",
    "dispatch_schema_reconcile",
  ],
  drops: [
    {
      field: "noInteractive",
      from: "setup_schema",
      why: "a CLI presentation flag ('apply recommendation verbatim and activate'). §11.2 step 4 removes the activate half outright, and the apply half is what this tool does — a proposal is always written, and a human always merges it",
    },
    {
      field: "json",
      from: "setup_schema",
      why: "CLI output formatting; §14.1 has one contract driving four surfaces, so rendering is the surface's job and never the schema's",
    },
    {
      field: "schemasCreated",
      from: "setup_schema",
      why: "output; nothing is created until merge (§11.2 step 4). The counts belong to the activation, which is not this call. The diff in the PR body is the pre-merge answer",
    },
    {
      field: "labelsCreated",
      from: "setup_schema",
      why: "output; as schemasCreated",
    },
    {
      field: "relationshipTypesCreated",
      from: "setup_schema",
      why: "output; as schemasCreated",
    },
    {
      field: "pinnedVersionId",
      from: "setup_schema",
      why: "output; the pin moves on merge and nowhere else (§11.2 step 4), so a proposal cannot report one",
    },
    {
      field: "versionId",
      from: "pin_schema_version",
      why: "input; there is no pin verb left. §11.8: the merged manifest freezes the version and moves the pin, so a caller cannot name which version to pin — they can only propose the manifest that becomes it",
    },
    {
      field: "pinnedVersionId",
      from: "pin_schema_version",
      why: "output; as above — no pin is moved by this call",
    },
    {
      field: "previousVersionId",
      from: "pin_schema_version",
      why: "output; the version this proposal is diffed against is `baseVersionId`, which is the pinned version at proposal time, not a pin that was replaced",
    },
    {
      field: "versionId",
      from: "create_schema_version",
      why: "output; a version id is assigned by indexing the merged manifest by digest (§11.8). A branch has a commit, not a version",
    },
    {
      field: "versionNumber",
      from: "create_schema_version",
      why: "output; as versionId — the number is frozen at merge",
    },
    {
      field: "publishedAt",
      from: "create_schema_version",
      why: "output; publication is the merge. A proposal has an opened-at, which lives on the pull request",
    },
    {
      field: "publishedVersionId",
      from: "toggle_schema",
      why: "output; v1 auto-published and auto-pinned on activation. §11.2 step 4 replaces that with merge, so a toggle is now an `enabled` flag written into manifest.json on the branch",
    },
    {
      field: "pinnedVersionId",
      from: "toggle_schema",
      why: "output; as publishedVersionId",
    },
    {
      field: "versionId",
      from: "dispatch_schema_reconcile",
      why: "input; reconciliation runs against the version the merge activates, which does not exist yet. What the caller controls here is the migration plan (§11.2 step 3: 'the PR body holds… the migration plan for existing entities'), carried as `migration`",
    },
    {
      field: "executionId",
      from: "dispatch_schema_reconcile",
      why: "output; no job is dispatched by opening a PR. The reconcile execution appears at activation and is polled through `list_sources`' reconcile block or `get_run`",
    },
    {
      field: "draftVersionId",
      from: "run_schema_chat",
      why: "input; §11.8 removes the Postgres draft version — the proposal branch is the draft. `proposalId` addresses it",
    },
    {
      field: "proposedMutations",
      from: "run_schema_chat",
      why: "output; v1 returned capability calls for a client to execute. v2 writes the edits onto the branch, and further edits go through `update_ontology`. Handing a caller a list of mutations to replay is how a branch and a registry drift apart",
    },
  ],

  // See the header: `high` from pin_schema_version/toggle_schema, deliberately
  // NOT `destructive` from dispatch_schema_reconcile. requiresApproval carries
  // from all three of those (true).
  agent: { requiresApproval: true, riskLevel: "medium", category: "schema" },
  sensitivity: "high",
  defaultEffect: "deny",
  // `create_schema_version`, `pin_schema_version` and `toggle_schema` are
  // Owner-only at workspace scope; `recommend_schema`, `setup_schema`,
  // `run_schema_chat` and `dispatch_schema_reconcile` allowed Member. The
  // stricter carries — an ontology proposal changes what every agent in the
  // workspace believes exists.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Creates a branch and a pull request on the main repo, and records the
  // proposal's provenance in the graph (§11.2 step 3). Writes nothing that
  // activates.
  mutates: true,

  input: z.object({
    /**
     * Carried from `recommend_schema` with its 1–5000 bound and 200 default.
     * §11.2 step 2: "a deterministic profiler reads a sample of source records
     * per source type". This is that sample size — the knob that trades profiler
     * cost against how many candidate classes it can see.
     */
    sampleLimit: schemaRecommend.input.shape.sampleLimit,

    /**
     * Carried from `setup_schema`. §11.8: "Enabled state and enforcement mode
     * live in the manifest." So this is no longer a registry setting the tool
     * applies — it is a value written into `manifest.json` on the branch and
     * activated by the merge.
     */
    enforcement: schemaSetup.input.shape.enforcement,

    /**
     * Carried from `create_schema_version`. The human tag ("Sales CRM v2")
     * becomes the pull request's title, and the change summary its body, which
     * §11.2 step 3 requires to hold the diff and the migration plan.
     */
    label: schemaVersionCreate.input.shape.label,
    changeSummary: schemaVersionCreate.input.shape.changeSummary,

    /**
     * The author half of "profiler plus author", carried from `run_schema_chat`
     * with its 1–10000 bound. What the customer wants the proposal to say, in
     * their own words; the model turns it into edits against the profiler's
     * candidates and never invents a class the profiler did not see (§11.2
     * step 2).
     */
    message: schemaChat.input.shape.message,
    conversationId: schemaChat.input.shape.conversationId,

    /**
     * What is left of `toggle_schema`: per-schema enabled flags, written into
     * `manifest.json` on the branch rather than applied. `schemaName` and
     * `enabled` are carried by import so the min(1) stays on the name.
     */
    schemaToggles: z
      .array(
        z.object({
          schemaName: schemaToggle.input.shape.schemaName,
          enabled: schemaToggle.input.shape.enabled,
        }),
      )
      .optional(),

    /**
     * What is left of `dispatch_schema_reconcile`: the migration plan §11.2
     * step 3 requires in the PR body. `prune` carries by import, default false —
     * the merge is what runs the reconcile, and a plan that prunes is a plan a
     * reviewer has to read before approving, which is exactly why it belongs in
     * the PR rather than in a separate dispatch call nobody reviews.
     */
    migration: z
      .object({
        prune: schemaReconcileDispatch.input.shape.prune,
      })
      .optional(),
  }),

  output: z.object({
    /**
     * New in v2, and the point of the tool. §11.8: "The engine's inferred
     * changes, an edit on the Ontology page, and a hand edit all become a branch
     * and a PR on the main repo." The proposal id is what `update_ontology`
     * takes to add further edits to the same branch.
     */
    proposalId: z.string(),
    branch: z.string(),
    pullRequestUrl: z.string(),
    pullRequestNumber: z.number().int(),

    /**
     * The pinned version this proposal is diffed against, so the PR body's diff
     * has a stated basis (§14: every number that is money shows its basis; the
     * same rule applied to a schema change). Null on a workspace with no
     * ontology yet — the onboarding case `recommend_schema` was written for.
     */
    baseVersionId: z.string().nullable(),

    /**
     * Carried whole from `recommend_schema`. The profiler's output is the
     * proposal's content: schemas, labels with their properties and data types,
     * and relationship types. Carried by import so `dataTypeEnum` and the nested
     * property shape stay the ones the profiler and the registry already agree
     * on — retyping this tree is how two definitions of `dataType` appear.
     */
    proposal: schemaRecommend.output.shape.proposal,
    rationale: schemaRecommend.output.shape.rationale,
    sampledCount: schemaRecommend.output.shape.sampledCount,

    // The author turn's reply, carried from `run_schema_chat`.
    assistantMessage: schemaChat.output.shape.assistantMessage,
    conversationId: schemaChat.output.shape.conversationId,

    /**
     * Carried from `pin_schema_version`/`toggle_schema`, and re-aimed: v1
     * reported these *after* moving the pin. Here they are computed on the diff
     * and shown *before* the merge, which is the only moment either warning can
     * still change a decision. `isDowngrade` means the proposal removes
     * vocabulary the pinned version has; `reconcileRecommended` means existing
     * entities will not match the new version without a migration pass.
     */
    isDowngrade: schemaVersionPin.output.shape.isDowngrade,
    reconcileRecommended: schemaVersionPin.output.shape.reconcileRecommended,
  }),
});

export type ProposeOntologyVersionInput = z.output<
  typeof proposeOntologyVersion.input
>;
export type ProposeOntologyVersionOutput = z.output<
  typeof proposeOntologyVersion.output
>;
