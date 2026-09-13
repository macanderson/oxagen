import { z } from "zod";
import { defineTool } from "./_define";
import { workspaceCreate } from "../workspace.create";
import { repoConfigure } from "../repo.configure";

/**
 * Appendix E: `create_workspace` — "workspace plus its main repo binding and
 * production branch". Absorbs `create_workspace` and `configure_repo`.
 *
 * This is the exemplar for the P1 carry (#2883). Three things it demonstrates:
 *
 * 1. **The carry is by import, not by retyping.** `name` and `slug` come off
 *    `workspaceCreate.input.shape`, so the slug's regex and its "lowercase
 *    letters, digits, and hyphens only" message stay attached to the field they
 *    describe. Retyping a schema drops exactly the parts that were learned.
 *
 * 2. **Absorbing is field-level.** `configure_repo` carries path filters, label
 *    filters, sync cadence, polling interval and field mappings. None of that is
 *    in this tool's job, so none of it is carried, and each omission is in
 *    `drops` with its destination.
 *
 * 3. **The spec can tighten what it carries.** §17's M0 acceptance test is "a
 *    workspace cannot be created without a main repo." v1 had no repo field at
 *    all; here the binding is required. A carry is not a copy — where the spec
 *    is stricter than the code, the spec wins and the change is commented.
 */
export const createWorkspace = defineTool({
  name: "create_workspace",
  domain: "org",
  description:
    "Create a workspace, bind its main repository, and set the production branch. A workspace cannot exist without a main repo (§17 M0).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["create_workspace", "configure_repo"],
  drops: [
    /**
     * The only drop here that is not an ingestion setting, and the one worth
     * reading: it is a change of *subject identity*, not of scope.
     */
    {
      field: "repoId",
      from: "configure_repo",
      why: "identity of the subject moved, not the capability. `configure_repo` took the id of a repository connection that already existed; this tool binds the main repo at the instant the workspace is created, and §10.1 makes that binding required at creation ('exactly one per workspace, required at creation' — a workspace without a main repo cannot exist), so there is no earlier step in which a connection could have been made and an id handed out. The repo is therefore named by provider coordinates instead — mainRepo.provider / mainRepo.owner / mainRepo.name — and resolved through the GitHub App installation, which is what mints the connection. The id is not lost, it is produced: it comes back as output.mainRepo.repoId, and every later call that needs one (sync_repository, update_source, unlink_repository) takes it from there.",
    },
    {
      field: "pathFilters",
      from: "configure_repo",
      why: "not carried anywhere, and not merely relocated: §11.4 step 4 has the code-graph indexer parse the production branch whole, so excluding paths would silently make the graph lie about what the repo contains. `link_repository` drops the same field from the same source for this reason; the two must not tell different stories about one field",
    },
    {
      field: "labelFilters",
      from: "configure_repo",
      why: "not carried anywhere: §11.4 step 3 backfills every issue with its labels, so a label filter would make an issue's absence indistinguishable from its deletion. Same reason `link_repository` gives for the same field",
    },
    {
      field: "recordTypes",
      from: "configure_repo",
      why: "not carried anywhere: §11.4 fixes what a repository contributes — events, issues, and the code graph — so which record types are ingested is no longer a per-repo choice. Same reason `link_repository` and `sync_repository` give for the same field",
    },
    {
      field: "syncCadence",
      from: "configure_repo",
      why: "the spec fixes repo sync to webhook-driven with manual re-sync (§11); the cadence is no longer a per-repo choice",
    },
    {
      field: "pollingIntervalSeconds",
      from: "configure_repo",
      why: "follows syncCadence — polling is gone",
    },
    {
      field: "fieldMappings",
      from: "configure_repo",
      why: "replaced by the ontology's grounding seam (§11.8), which reads .oxagen/ontology/ rather than per-repo mappings",
    },
  ],

  // Both sources agree on sensitivity and defaultEffect. `create_workspace` is
  // the stricter of the two on approval (requiresApproval: true vs false), and
  // creating a workspace now also provisions a Neo4j database (§5), so the
  // stricter value carries.
  agent: { requiresApproval: true, riskLevel: "medium", category: "workspace" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes Postgres (org.workspaces), provisions a Neo4j database, and writes
  // the repo binding. Carried from both sources, which are both mutations.
  mutates: true,

  input: z.object({
    // Carried by reference so the slug regex and its message stay with the field.
    name: workspaceCreate.input.shape.name,
    slug: workspaceCreate.input.shape.slug,

    // New in v2, required by §17 M0: "A workspace cannot be created without a
    // main repo." `configure_repo` identified an already-connected repo by id;
    // at workspace-creation time there is no connection yet, so the binding is
    // by provider coordinates and is resolved through the GitHub App.
    mainRepo: z.object({
      provider: z.literal("github"),
      owner: z.string().min(1),
      name: z.string().min(1),
      /**
       * §11: the production branch is the one whose pushes update the code
       * graph. Pushes to any other branch are ignored, so this is a governance
       * choice, not a convenience — it is required rather than defaulted to
       * "main", which would silently index the wrong branch for the many repos
       * that ship from a release branch.
       */
      productionBranch: z.string().min(1),
    }),
  }),

  output: z.object({
    publicId: workspaceCreate.output.shape.publicId,
    name: workspaceCreate.output.shape.name,
    slug: workspaceCreate.output.shape.slug,
    orgSlug: workspaceCreate.output.shape.orgSlug,
    createdAt: workspaceCreate.output.shape.createdAt,

    mainRepo: z.object({
      // `configure_repo` returned repoId + displayName; both carry.
      repoId: repoConfigure.output.shape.repoId,
      displayName: repoConfigure.output.shape.displayName,
      productionBranch: z.string(),
    }),

    /**
     * §5.3: each organization gets its own Neo4j database. Surfaced so the
     * caller can tell a provisioned workspace from one whose graph is still
     * being created — the UI cannot ask the graph anything until this is ready.
     */
    graphDatabase: z.object({
      name: z.string(),
      status: z.enum(["provisioning", "ready"]),
    }),
  }),
});

export type CreateWorkspaceInput = z.output<typeof createWorkspace.input>;
export type CreateWorkspaceOutput = z.output<typeof createWorkspace.output>;
