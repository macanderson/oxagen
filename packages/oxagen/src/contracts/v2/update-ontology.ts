import { z } from "zod";
import { defineTool } from "./_define";
import { schemaLabelUpsert } from "../schema.label.upsert";
import { schemaPropertyUpsert } from "../schema.property.upsert";
import { schemaRelationshipUpsert } from "../schema.relationship.upsert";
import { schemaLabelDelete } from "../schema.label.delete";
import { schemaPropertyDelete } from "../schema.property.delete";
import { schemaRelationshipDelete } from "../schema.relationship.delete";
import { schemaValidateNode } from "../schema.validate.node";
import { schemaValidateRelationship } from "../schema.validate.relationship";

/**
 * Appendix E: `update_ontology` — "edits on a proposal branch". Absorbs the six
 * draft mutations (`upsert_schema_label`, `upsert_schema_property`,
 * `upsert_schema_relationship`, and their three deletes) and the two validators
 * (`validate_schema_node`, `validate_schema_relationship`).
 *
 * Two things change from v1, and the `Does` column names the first:
 *
 * 1. **Where the edit lands.** Every v1 mutation said "within the draft
 *    version" — a Postgres row §11.8 removes. The draft is now a branch, so
 *    `proposalId` is required. An edit with nowhere to land is exactly the
 *    orphaned draft the spec set out to delete.
 *
 * 2. **Six calls become one.** A schema change is rarely one label: adding a
 *    class means the label, its properties, and the relationships that reach it.
 *    v1 made that N round trips against shared mutable state, where a failure
 *    halfway left a draft that was neither the old shape nor the new one. One
 *    `edits[]` array is one commit on the branch — either the whole change is on
 *    it or none of it is.
 *
 * The union members are composed by spreading each absorbed contract's
 * `input.shape`, so every validation message survives intact: the relationship
 * type's `^[A-Z][A-Z0-9_]{0,62}$` guard, the 200-char key cap, the 2000-char
 * grounding description that the extraction AI actually reads, and the
 * `propertyInputSchema` tree with its enum values, item types and constraints.
 * Retyping any of those would silently widen what the registry accepts.
 */

/** One edit against the proposal branch. Each member is an absorbed contract's
 * own input shape, discriminated by the verb it used to be. */
const ontologyEdit = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert_label"), ...schemaLabelUpsert.input.shape }),
  z.object({ op: z.literal("delete_label"), ...schemaLabelDelete.input.shape }),
  z.object({
    op: z.literal("upsert_property"),
    ...schemaPropertyUpsert.input.shape,
  }),
  z.object({
    op: z.literal("delete_property"),
    ...schemaPropertyDelete.input.shape,
  }),
  z.object({
    op: z.literal("upsert_relationship"),
    ...schemaRelationshipUpsert.input.shape,
  }),
  z.object({
    op: z.literal("delete_relationship"),
    ...schemaRelationshipDelete.input.shape,
  }),
]);

export const updateOntology = defineTool({
  name: "update_ontology",
  domain: "schema",
  description:
    "Apply ontology edits — labels, properties and relationship types — as one commit on a proposal branch (§11.8). Optionally validates candidate nodes and relationships against the edited ontology without committing.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: [
    "upsert_schema_label",
    "upsert_schema_property",
    "upsert_schema_relationship",
    "delete_schema_label",
    "delete_schema_property",
    "delete_schema_relationship",
    "validate_schema_node",
    "validate_schema_relationship",
  ],
  drops: [
    {
      field: "labelId",
      from: "upsert_schema_label",
      why: "output; a branch edit writes .oxagen/ontology/schemas/<schema>/labels/<Label>.json — there is no row and no id. Identifiers are assigned when the merged manifest is indexed by digest (§11.2 step 4, §11.8). The file path is returned instead, which is what a reviewer can actually open",
    },
    {
      field: "propertyId",
      from: "upsert_schema_property",
      why: "output; as labelId — properties live inside their owner's file on the branch",
    },
    {
      field: "relationshipTypeId",
      from: "upsert_schema_relationship",
      why: "output; as labelId",
    },
    {
      field: "labelName",
      from: "delete_schema_label",
      why: "output; an echo of the input, folded into the per-edit result's `name` so all six verbs report one shape rather than three differently-named echoes",
    },
    {
      field: "propertyKey",
      from: "delete_schema_property",
      why: "output; as labelName",
    },
    {
      field: "relationshipTypeName",
      from: "delete_schema_relationship",
      why: "output; as labelName",
    },
    {
      field: "versionId",
      from: "validate_schema_node",
      why: "input; v1 validated against a pinned or named version. Here the point is to validate against the ontology *as this proposal would leave it* — validating against an already-published version would answer a question the caller is not asking",
    },
    {
      field: "versionId",
      from: "validate_schema_relationship",
      why: "input; as validate_schema_node's",
    },
  ],

  /**
   * The three deletes are `high` / medium risk / approval-required; the three
   * upserts and both validators are lower. The strictest carries on every axis,
   * and correctly: a single `edits[]` array can contain a delete, so the tool is
   * graded as though it always does. §11.8's PR checks then catch the specific
   * hazard the grade exists for — "no label removed while entities carry it
   * without a migration plan".
   */
  agent: { requiresApproval: true, riskLevel: "medium", category: "schema" },
  sensitivity: "high",
  defaultEffect: "deny",
  // The six mutations all allow workspace Owner/Member; the two validators also
  // allowed Viewer. The stricter carries — a Viewer has no branch to write to.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Commits to the proposal branch. Six of the eight sources mutate.
  mutates: true,

  input: z.object({
    /**
     * Required, and new. §11.8 makes the branch the draft, so an edit must name
     * the proposal it belongs to — the one `propose_ontology_version` opened.
     * v1 had no equivalent because there was one implicit draft per workspace,
     * which is precisely the shared mutable state that made two people's
     * concurrent schema edits indistinguishable.
     */
    proposalId: z.string().min(1),

    /**
     * The edits, applied in order as one commit. `.min(1)` because an empty
     * commit on a proposal branch is a no-op that still moves the PR's head and
     * re-triggers its checks.
     */
    edits: z.array(ontologyEdit).min(1),

    /**
     * What is left of the two validators. §5.1/§4.6's conformance machinery is
     * unchanged — it is *when* it runs that moves. v1 validated an instance
     * against a published version; here a caller checks candidate instances
     * against the ontology this proposal would produce, which is the check that
     * can still change the proposal.
     *
     * Both inner shapes are carried by import, minus their `versionId`.
     */
    validate: z
      .object({
        nodes: z
          .array(
            z.object({
              label: schemaValidateNode.input.shape.label,
              properties: schemaValidateNode.input.shape.properties,
            }),
          )
          .optional(),
        relationships: z
          .array(
            z.object({
              type: schemaValidateRelationship.input.shape.type,
              startLabel: schemaValidateRelationship.input.shape.startLabel,
              endLabel: schemaValidateRelationship.input.shape.endLabel,
              properties: schemaValidateRelationship.input.shape.properties,
            }),
          )
          .optional(),
      })
      .optional(),

    /**
     * New. When true the edits are rendered and validated but nothing is
     * committed — the Ontology page's live preview, and the safe way for an
     * agent to find out that a delete it intended would orphan a relation.
     */
    dryRun: z.boolean().default(false),
  }),

  output: z.object({
    proposalId: z.string(),

    /**
     * §11.8: an edit is a commit on the branch. Null on a `dryRun`, which is how
     * a caller distinguishes "validated, nothing written" from "written".
     */
    commitSha: z.string().nullable(),

    /**
     * One result per edit, in input order. `created` and `deleted` are carried
     * by import from the upsert and delete outputs so the booleans mean what
     * they meant in v1; `path` replaces the three dropped row ids with the thing
     * a reviewer opens in the pull request.
     */
    results: z.array(
      z.object({
        op: z.enum([
          "upsert_label",
          "delete_label",
          "upsert_property",
          "delete_property",
          "upsert_relationship",
          "delete_relationship",
        ]),
        name: z.string(),
        path: z.string().describe("File path under .oxagen/ontology/"),
        created: schemaLabelUpsert.output.shape.created.optional(),
        deleted: schemaLabelDelete.output.shape.deleted.optional(),
      }),
    ),

    /**
     * Present when `validate` was supplied. Carried whole from the two
     * validators — `conformanceScore`, the field-level `errors` with their
     * machine-readable codes, `missingRequired`, and the three-way `outcome`
     * that distinguishes a rejection from a write below the conformance floor.
     * That last enum is the one a caller must not re-derive: "written below
     * floor" is a successful write that still counts against §11.5's quality
     * measurement.
     */
    validation: z
      .object({
        nodes: z
          .array(
            z.object({
              valid: schemaValidateNode.output.shape.valid,
              conformanceScore:
                schemaValidateNode.output.shape.conformanceScore,
              errors: schemaValidateNode.output.shape.errors,
              missingRequired: schemaValidateNode.output.shape.missingRequired,
              outcome: schemaValidateNode.output.shape.outcome,
            }),
          )
          .optional(),
        relationships: z
          .array(
            z.object({
              valid: schemaValidateRelationship.output.shape.valid,
              conformanceScore:
                schemaValidateRelationship.output.shape.conformanceScore,
              errors: schemaValidateRelationship.output.shape.errors,
              missingRequired:
                schemaValidateRelationship.output.shape.missingRequired,
              outcome: schemaValidateRelationship.output.shape.outcome,
            }),
          )
          .optional(),
      })
      .optional(),
  }),
});

export type UpdateOntologyInput = z.output<typeof updateOntology.input>;
export type UpdateOntologyOutput = z.output<typeof updateOntology.output>;
