import { z } from "zod";
import { defineTool } from "./_define";
import { repoConfigure } from "../repo.configure";
import { repoSync } from "../repo.sync";
import { connectionMappingsSet } from "../connection.mappings.set";

/**
 * Appendix E: `link_repository` — "link, role, production branch, issue import".
 * Absorbs `configure_repo` and `sync_repo`.
 *
 * §11.4 is the whole contract: linking a repository does four things, in order —
 * confirm the production branch, subscribe the App to events, import issues, and
 * build the code graph. Everything in the input is one of those four; everything
 * `configure_repo` carried that is *not* one of those four is dropped.
 *
 * Three judgment calls a reviewer should check:
 *
 * 1. **v1 addressed an already-connected repo; v2 does the connecting.**
 *    `configure_repo` took a `repoId` for a connection that already existed. At
 *    link time there is no connection, so the repository is named by provider
 *    coordinates and resolved through the GitHub App installation — the same
 *    reason `create_workspace` binds its main repo by owner/name.
 *
 * 2. **`role` is new and §10.1 requires it.** "One main repo, any number of
 *    linked repos" is a governance distinction (the main repo holds
 *    `.oxagen/`), and v1 had no concept of it at all.
 *
 * 3. **The initial index is not a mode choice.** `sync_repo` let the caller pick
 *    incremental or full. A link has nothing to be incremental against — §11.4
 *    step 4 clones the production branch head and indexes it — so the mode is
 *    gone and only the job handle carries over.
 */
export const linkRepository = defineTool({
  name: "link_repository",
  domain: "repo",
  description:
    "Link a GitHub repository to the workspace: confirm its production branch, subscribe the App to events, import issues, and build the code graph (§11.4).",
  // `configure_repo` was sync and `sync_repo` async. A link ends in a queued
  // index and (optionally) a queued issue backfill, so the async source wins:
  // the caller gets job handles, not a finished graph.
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["configure_repo", "sync_repo"],
  drops: [
    {
      field: "repoId",
      from: "configure_repo",
      why: "v1 configured an already-connected repo; v2 performs the link itself, so the repository is named by provider coordinates and resolved through the GitHub App installation (§11.4 step 1)",
    },
    {
      field: "recordTypes",
      from: "configure_repo",
      why: "§11.4 fixes what a repository contributes — events, issues, and the code graph. Which record types are ingested is no longer a per-repo choice",
    },
    {
      field: "pathFilters",
      from: "configure_repo",
      why: "ingestion scope, not the link — the code-graph indexer parses the production branch whole (§11.4 step 4); excluding paths would silently make the graph lie about what the repo contains",
    },
    {
      field: "labelFilters",
      from: "configure_repo",
      why: "§11.4 step 3 backfills every issue with its labels; a label filter would make an issue's absence indistinguishable from its deletion",
    },
    {
      field: "syncCadence",
      from: "configure_repo",
      why: "§11.4: delivery is webhook-driven into a durable job, with no polling and no cron. Cadence is not configurable",
    },
    {
      field: "pollingIntervalSeconds",
      from: "configure_repo",
      why: "follows syncCadence — polling is gone (§11.4)",
    },
    {
      field: "fieldMappings",
      from: "configure_repo",
      why: "replaced by the ontology's grounding seam (§11.8), which reads .oxagen/ontology/ rather than per-repo mappings",
    },
    {
      field: "mode",
      from: "sync_repo",
      why: "a link has no cursor to be incremental against; §11.4 step 4 always clones and indexes the production branch head. The incremental path is what `push` events do afterwards",
    },
    {
      field: "recordTypes",
      from: "sync_repo",
      why: "same reason as configure_repo's: the initial index is whole-repo by construction",
    },
  ],

  // `configure_repo` and `sync_repo` agree: medium sensitivity, medium risk, no
  // approval. The approval is raised here on the spec's authority (§10.1): "A
  // workspace without a main repo cannot exist. Changing which repo is main is
  // an org-owner action with approval, recorded as a security event." Linking
  // also grants the App event access to a repository, which is a permission
  // change, not a configuration change.
  agent: { requiresApproval: true, riskLevel: "medium", category: "ingestion" },
  sensitivity: "medium",
  defaultEffect: "deny",
  // Both sources allowed workspace Member. §10.1 makes the main-repo binding an
  // owner action, and v2 cannot tell at policy-evaluation time which role the
  // call will claim, so Member does not carry.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes the repository link row, registers webhooks with GitHub, and queues
  // the index and backfill jobs. Both sources mutate.
  mutates: true,

  input: z.object({
    /**
     * New in v2. `configure_repo` took a connection id; the link is what creates
     * that connection, so the repository is identified the way `create_workspace`
     * identifies its main repo — by coordinates the GitHub App can resolve.
     */
    provider: z.literal("github"),
    owner: z.string().min(1),
    name: z.string().min(1),

    // Carried by import: the wizard's GitHub App installation id, with the
    // describe() that says what it is. §11.4 resolves the repository through
    // this installation, so it is required here where the wizard left it
    // optional — there is no other way to reach the repository's events.
    installationId: connectionMappingsSet.input.shape.installationId.unwrap(),

    /**
     * §10.1: exactly one `main` per workspace (it holds `.oxagen/` — steering,
     * agents, and the ontology), zero or more `linked`. v1 had no role field;
     * the default is the safe one, because promoting a repo to main moves where
     * the workspace's governance lives.
     */
    role: z.enum(["main", "linked"]).default("linked"),

    /**
     * §11.4 step 1: the production branch is the only branch whose commits
     * update the code graph. Required rather than defaulted to GitHub's default
     * branch — the dialog shows that default as a *suggestion* and the customer
     * confirms it, because a repo that ships from `release` would otherwise be
     * indexed from the wrong line without anyone being asked.
     */
    productionBranch: z.string().min(1),

    /**
     * §11.4 step 3: a one-time paginated backfill, only if the repository has
     * Issues enabled. Opt-out rather than opt-in because issues are what let
     * spend roll up to a task reference without anyone tagging anything.
     */
    importIssues: z.boolean().default(true),
  }),

  output: z.object({
    // Both carried from `configure_repo`, which is where the UI already reads
    // a repository's identity from.
    repoId: repoConfigure.output.shape.repoId,
    displayName: repoConfigure.output.shape.displayName,

    role: z.enum(["main", "linked"]),
    productionBranch: z.string(),

    /**
     * §11.4 step 4's clone-and-index, as `sync_repo` already reported it. The
     * job handle and the queued literal carry verbatim so the Ontology page's
     * Repositories tab can poll one shape for a link and for a manual re-index.
     */
    codeGraphJob: z.object({
      jobId: repoSync.output.shape.jobId,
      status: repoSync.output.shape.status,
      estimatedRecords: repoSync.output.shape.estimatedRecords,
    }),

    /**
     * §11.4 step 3. Null when the repository has Issues disabled or the caller
     * opted out — distinguishable from "queued but empty", which the progress
     * bar on the Ontology page needs.
     */
    issueImportJob: z
      .object({
        jobId: repoSync.output.shape.jobId,
        status: repoSync.output.shape.status,
      })
      .nullable(),

    /**
     * §11.4 step 2: the App subscribes the repository to every event the product
     * uses. Surfaced so a link whose webhook registration failed is visible as
     * a link, rather than as a repository that silently never updates.
     */
    events: z.object({
      subscribed: z.boolean(),
      deliveryUrl: z.string().nullable(),
    }),
  }),
});

export type LinkRepositoryInput = z.output<typeof linkRepository.input>;
export type LinkRepositoryOutput = z.output<typeof linkRepository.output>;
