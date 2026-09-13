import { z } from "zod";
import { defineTool } from "./_define";
import { repoSync } from "../repo.sync";
import { repoResume } from "../repo.resume";

/**
 * Appendix E: `sync_repository` — "manual full re-index". Absorbs `sync_repo`,
 * `resume_repo` and `sync_integration`.
 *
 * §11.4 names this tool by name and spends a paragraph on it: "A **manual sync**
 * (`sync_repository`, a governed action on the Ontology page and the API) does a
 * full re-index of the production branch head. It is idempotent. It archives
 * anything the full pass does not see, with the current commit as `valid_to`. An
 * operator reaches for it after a force-push, a history rewrite, or a doubt. It
 * is never scheduled."
 *
 * Every carry decision falls out of that paragraph:
 *
 * - **`mode` is gone.** Both `sync_repo` and `sync_integration` let the caller
 *   choose incremental or full. The incremental path is now what a `push` event
 *   does automatically; asking for a manual sync *is* asking for the full pass.
 *   Leaving the choice in would give an operator a way to reach for this tool
 *   after a force-push and have it do nothing useful.
 * - **`nextSyncAt` is gone.** "It is never scheduled" — there is no next sync to
 *   report, and reporting one would be a badge that describes trust while
 *   showing something stronger than the recorded value (§14).
 * - **`resume_repo` survives only as an effect.** A link that had stopped
 *   receiving events is re-armed by the same pass that re-indexes it, so
 *   resuming is an output flag rather than a separate governed action.
 */
export const syncRepository = defineTool({
  name: "sync_repository",
  domain: "repo",
  description:
    "Manually re-index a repository's production branch head in full. Idempotent; archives anything the pass does not see with the current commit as valid_to (§11.4). Never scheduled.",
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["sync_repo", "resume_repo", "sync_integration"],
  drops: [
    {
      field: "mode",
      from: "sync_repo",
      why: "§11.4: a manual sync is defined as a full re-index of the production branch head. Incremental updates are what `push` events do; offering the choice here would let an operator ask for a re-index after a force-push and silently get the incremental path that the force-push already broke",
    },
    {
      field: "recordTypes",
      from: "sync_repo",
      why: "a full pass archives whatever it does not see; restricting it to some record types would stamp valid_to on nothing and leave the archive claim false",
    },
    {
      field: "integrationId",
      from: "sync_integration",
      why: "a repository is addressed as a repository (§14 Ontology → Repositories); Appendix E drops the plugin family, so `repoId` is the only identifier",
    },
    {
      field: "mode",
      from: "sync_integration",
      why: "same as sync_repo's — the manual pass is full by definition (§11.4)",
    },
    {
      field: "nextSyncAt",
      from: "resume_repo",
      why: "output; §11.4 states a manual sync 'is never scheduled', so there is no next sync to name. Ongoing freshness comes from webhook delivery, which has no schedule either",
    },
    {
      field: "resumedAt",
      from: "resume_repo",
      why: "output; folded into the `resumed` boolean — the timestamp of the re-arm is the sync job's own start, already on the job record",
    },
  ],

  // `sync_repo` and `sync_integration` are medium/medium; `resume_repo` is
  // low/low. The stricter pair carries. All three set requiresApproval: false,
  // and that carries too: §11.4 calls the manual sync "a governed action", which
  // is the policy layer's decision per workspace (§6.12), not a hard-coded
  // approval on every call — an operator recovering from a force-push should not
  // need to wait on a human by construction.
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "ingestion",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  // All three sources agree on org Owner/Admin + workspace Owner/Member, and
  // nothing in the spec tightens it: a full re-index is recoverable and
  // idempotent, unlike linking or unlinking.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Re-parses the production branch into Neo4j and stamps valid_to on anything
  // the pass does not see. All three sources mutate.
  mutates: true,

  input: z.object({
    // Carried from `sync_repo` — the same identifier `resume_repo` used.
    repoId: repoSync.input.shape.repoId,
  }),

  output: z.object({
    // Carried from `sync_repo`: the job handle and the queued literal, so the
    // Repositories tab polls the same shape it polls after a link.
    jobId: repoSync.output.shape.jobId,
    status: repoSync.output.shape.status,
    estimatedRecords: repoSync.output.shape.estimatedRecords,

    repoId: repoResume.output.shape.repoId,

    /**
     * What is left of `resume_repo`. True when this pass also re-armed a link
     * whose event delivery had stopped — the operator asked for a re-index and
     * got a reconnection as well, and needs to be told rather than discover it.
     */
    resumed: z.boolean(),

    /**
     * §11.4: the pass indexes "the production branch head". Echoing the commit
     * it is indexing makes the result auditable against what the operator
     * believed they were recovering to after a history rewrite.
     */
    productionBranch: z.string(),
    headCommit: z.string(),
  }),
});

export type SyncRepositoryInput = z.output<typeof syncRepository.input>;
export type SyncRepositoryOutput = z.output<typeof syncRepository.output>;
