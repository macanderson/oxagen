import { z } from "zod";
import { defineTool } from "./_define";
import { schemaRegistryGet } from "../schema.registry.get";
import { schemaVersionList } from "../schema.version.list";
import { schemaVersionDiff } from "../schema.version.diff";
import { schemaExport } from "../schema.export";
import { graphNodeLabelsGet } from "../graph.node_label.get";

/**
 * Appendix E: `get_ontology` — "active version, classes, relations, synonyms,
 * proposals, diffs; also served to agents as `graph` frames". Absorbs
 * `get_schema_registry`, `list_schema_versions`, `list_schemas`,
 * `diff_schema_versions`, `export_schema` and `get_node_labels`.
 *
 * §11.6 names this tool first of the four graph reads and says what it is for:
 * "how an agent learns the shape before it asks anything… A planning model reads
 * this the way it reads a database schema." So the six sources collapse into one
 * question — *what kinds of things exist here* — asked at five levels of detail:
 * the active version, its history, a diff between two versions, an archive of
 * one, and the labels on a single node.
 *
 * **`mutates` is deliberately omitted, and that is the finding in this file.**
 * Five of the six sources look like pure reads and are not:
 *
 *   - `get_schema_registry`, `list_schema_versions` and `list_schemas` all call
 *     `getOrCreateRegistry()` (packages/handlers/src/schema.versioning.ts), which
 *     INSERTs a `schema_registries` row and a fresh draft version when a
 *     workspace reads its ontology for the first time.
 *   - `export_schema` calls `persistGeneratedAsset()` — the archive is a stored
 *     asset row with an access policy, not a streamed response.
 *
 * Only `diff_schema_versions` and `get_node_labels` are genuinely read-only.
 * Rule: absent means it mutates, and the name does not settle it. The lazy
 * registry creation is arguably an artifact §11.8 removes (the Postgres registry
 * stops being the store), and the archive write is arguably incidental — but
 * neither is established here, so the field stays off rather than being guessed.
 */
export const getOntology = defineTool({
  name: "get_ontology",
  domain: "schema",
  description:
    "Read the workspace's ontology: the active version's classes, properties, relation types and synonyms, its version history, open proposals, a diff between two versions, and optionally an archive. Served to agents as `graph` context frames (§11.6).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: [
    "get_schema_registry",
    "list_schema_versions",
    "list_schemas",
    "diff_schema_versions",
    "export_schema",
    "get_node_labels",
  ],
  renames: [
    {
      from: "fromVersionId",
      source: "diff_schema_versions",
      to: "diffFrom",
      why: "`diff_schema_versions` was a two-sided call and named both sides symmetrically (`fromVersionId`/`toVersionId`). Here the diff is a modifier on a read that already has a subject: `versionId` is the version being read and is the diff's right-hand side, so `toVersionId` is dropped (see `drops`) and the surviving side is named for what it now is — the version to diff *from*. Keeping `fromVersionId` next to `versionId` would read as though both named the thing being read. Carried by import, so the min(1) that rejects an empty version id stays attached",
    },
  ],
  drops: [
    {
      field: "registryId",
      from: "get_schema_registry",
      why: "output; §11.8 removes the Postgres registry as the store ('the `schema_registry.*` tables are gone'). The ontology is addressed by version digest and by the files in .oxagen/ontology/, so a registry row id names something a caller can no longer act on",
    },
    {
      field: "draftVersionId",
      from: "get_schema_registry",
      why: "output; there is no draft version — §11.8 makes a proposal branch the draft, and open proposals are returned in `proposals` with their pull requests",
    },
    {
      field: "toVersionId",
      from: "diff_schema_versions",
      why: "input; the diff's right-hand side is `versionId`, the version this call is already reading. Two version parameters would let a caller ask for a diff between two versions while being shown the classes of a third",
    },
    {
      field: "schemas",
      from: "list_schemas",
      why: "output; the flat per-schema list (name, displayName, source, connectorId, enabled) is a strict subset of `get_schema_registry`'s richer tree, which carries the same five fields plus the labels and relationship types under them. One shape, not two",
    },
    {
      field: "versionNumber",
      from: "export_schema",
      why: "output; the version number is already on the `versions` rows and on the resolved `versionId`. Repeating it inside the archive block invites the two disagreeing",
    },
    {
      field: "nodeId",
      from: "get_node_labels",
      why: "output; an echo of the input. The caller passed it, and unlike `expand_graph` there is no traversal here that could have resolved it to a different node",
    },
  ],

  // Five sources are `medium`; `get_node_labels` alone is `low`. The stricter
  // carries. riskLevel low and requiresApproval false are unanimous.
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  /**
   * The sources disagree at workspace scope: four of the six allow Viewer, but
   * `export_schema` allows Owner/Member only. The stricter carries, so **Viewer
   * does not**. Flagged for review: it means a Viewer cannot read the Ontology
   * page's Model tab, which §14 calls "the page the product is known for". The
   * alternative — a Viewer allowance on a tool that can also mint a downloadable
   * archive of the whole ontology — is the worse of the two, and if the Viewer
   * read is wanted it should come back as a narrowing of `format` rather than as
   * a quiet widening of the role set here.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // `mutates` intentionally omitted — see the header. Two of the six source
  // handlers write (lazy registry creation, and the archive's asset row).

  input: z.object({
    // Carried from `get_schema_registry`, keeping "defaults to pinned".
    versionId: schemaRegistryGet.input.shape.versionId,

    /**
     * Folds `diff_schema_versions` in. When set, the response carries a diff
     * from this version to `versionId`. Carried by import so the min(1) that
     * rejects an empty version id stays attached.
     */
    diffFrom: schemaVersionDiff.input.shape.fromVersionId.optional(),

    /**
     * §14's Versions tab is "the git history of `.oxagen/ontology/`". Off by
     * default because an agent asking "what classes exist" (§11.6) does not want
     * the history, and the history is the expensive half.
     */
    includeVersions: z.boolean().default(false),

    // Carried from `list_schema_versions` with its 1–100 cap.
    limit: schemaVersionList.input.shape.limit,
    offset: schemaVersionList.input.shape.offset,

    /**
     * Folds `export_schema` in. `inline` returns the ontology in the response;
     * `archive` builds the ZIP through the asset chokepoint and returns a
     * serve URL. A flag rather than a separate tool because §11.8 says the
     * export layout *is* the on-disk layout — an export and a read are the same
     * content in two encodings.
     */
    format: z.enum(["inline", "archive"]).default("inline"),

    /**
     * Folds `get_node_labels` in, carried by import with its describe(). "What
     * classes does this instance carry" is an ontology question asked from a
     * node, and §11.6's `graph` frames answer it alongside the class list rather
     * than in a separate round trip.
     */
    nodeId: graphNodeLabelsGet.input.shape.nodeId.optional(),
  }),

  output: z.object({
    /**
     * The active version. Carried from `get_schema_registry`, whose tree already
     * uses `propertyInputSchema` and `cardinalityEnum` — the same shapes
     * `update_ontology` writes with, so a round trip through a proposal cannot
     * change a property's meaning.
     */
    pinnedVersionId: schemaRegistryGet.output.shape.pinnedVersionId,
    enforcementMode: schemaRegistryGet.output.shape.enforcementMode,
    conformanceFloor: schemaRegistryGet.output.shape.conformanceFloor,
    schemas: schemaRegistryGet.output.shape.schemas,

    /**
     * New. §11.6 lists "synonyms and example questions" among what this tool
     * returns, and §11.8's label files carry `synonyms[]`; neither exists on any
     * absorbed contract. They matter because §11.6 #4 feeds both to the
     * natural-language-to-Cypher compiler — the synonyms are how a customer's
     * word for a class reaches the query, and the examples are the few-shot set.
     */
    synonyms: z.record(z.string(), z.array(z.string())),
    exampleQuestions: z.array(z.string()),

    /**
     * §14's Versions tab: "open proposals as pull requests with diffs". New —
     * v1 had no proposal object because v1 activated in place. The shape mirrors
     * what `propose_ontology_version` returns so the two agree on what a
     * proposal is.
     */
    proposals: z.array(
      z.object({
        proposalId: z.string(),
        branch: z.string(),
        pullRequestUrl: z.string(),
        pullRequestNumber: z.number().int(),
        label: z.string().nullable(),
        openedAt: z.string(),
      }),
    ),

    // Present when `includeVersions`. Carried whole from
    // `list_schema_versions`, `isPinned` included.
    versions: schemaVersionList.output.shape.versions.optional(),
    versionsTotal: schemaVersionList.output.shape.total.optional(),

    /**
     * Present when `diffFrom` is set. Carried field-by-field from
     * `diff_schema_versions` — every added/removed/changed bucket for schemas,
     * labels, relationship types and properties. The `changes: string[]` arrays
     * inside the "changed" buckets are what §14 means by an explanation being a
     * chain rather than a summary.
     */
    diff: z
      .object({
        schemasAdded: schemaVersionDiff.output.shape.schemasAdded,
        schemasRemoved: schemaVersionDiff.output.shape.schemasRemoved,
        labelsAdded: schemaVersionDiff.output.shape.labelsAdded,
        labelsRemoved: schemaVersionDiff.output.shape.labelsRemoved,
        labelsChanged: schemaVersionDiff.output.shape.labelsChanged,
        relationshipTypesAdded:
          schemaVersionDiff.output.shape.relationshipTypesAdded,
        relationshipTypesRemoved:
          schemaVersionDiff.output.shape.relationshipTypesRemoved,
        relationshipTypesChanged:
          schemaVersionDiff.output.shape.relationshipTypesChanged,
        propertiesAdded: schemaVersionDiff.output.shape.propertiesAdded,
        propertiesRemoved: schemaVersionDiff.output.shape.propertiesRemoved,
        propertiesChanged: schemaVersionDiff.output.shape.propertiesChanged,
      })
      .optional(),

    /**
     * Present when `format: "archive"`. Carried from `export_schema`, keeping
     * the describe() that says the URL is access-controlled — the one fact about
     * this field that a caller must not assume.
     */
    archive: z
      .object({
        assetId: schemaExport.output.shape.assetId,
        serveUrl: schemaExport.output.shape.serveUrl,
      })
      .optional(),

    // Present when `nodeId` is set. Carried from `get_node_labels`.
    nodeLabels: graphNodeLabelsGet.output.shape.labels.optional(),
  }),
});

export type GetOntologyInput = z.output<typeof getOntology.input>;
export type GetOntologyOutput = z.output<typeof getOntology.output>;
