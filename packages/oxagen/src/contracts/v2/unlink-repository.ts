import { z } from "zod";
import { defineTool } from "./_define";
import { repoPause } from "../repo.pause";
import { integrationDelete } from "../integration.delete";

/**
 * Appendix E: `unlink_repository`. Absorbs `pause_repo` and `delete_integration`.
 *
 * Appendix E leaves the `Does` column empty for this row, so the job is read off
 * its two sources and §11.4: stop the event subscription, remove the link, and
 * decide what happens to what the repository already put in the graph.
 *
 * The interesting carry is that **pausing did not survive**. `pause_repo` exists
 * because v1 had a polling loop to stop. §11.4 replaced polling with webhook
 * delivery into a durable job, so there is nothing to pause — a repository is
 * either linked and receiving events, or it is not. `pause_repo` therefore
 * contributes only its addressing (`repoId`) and its role as the thing v2 is the
 * terminal form of; its paused-state output is dropped.
 *
 * The second call is that `delete_integration`'s `purgeData` carries unchanged.
 * It is the one genuinely irreversible choice here, and §11.1 is why it has to
 * be a choice: entities carry `DERIVED_FROM → :SourceRecord` provenance, so
 * purging a repository's records orphans every entity that was resolved from
 * them. Keeping the data is the default; a customer who wants it gone asks.
 */
export const unlinkRepository = defineTool({
  name: "unlink_repository",
  domain: "repo",
  description:
    "Unlink a repository from the workspace: stop event delivery, remove the link, and optionally purge the repository's records and code graph from Neo4j.",
  // `delete_integration` is async and its purge is the reason: removing a
  // repository's nodes from Neo4j is a background job, not a request.
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["pause_repo", "delete_integration"],
  drops: [
    {
      field: "integrationId",
      from: "delete_integration",
      why: "a repository link is addressed as a repository (§14 Ontology → Repositories), not as a plugin instance; Appendix E drops the plugin family outright, so `repoId` is the only identifier left",
    },
    {
      field: "status",
      from: "pause_repo",
      why: "output; `paused` is not a state a repository link can be in — §11.4 delivery is webhook-driven with no polling to suspend, so the only states are linked and unlinked",
    },
    {
      field: "pausedAt",
      from: "pause_repo",
      why: "output; follows `status` — there is no pause to timestamp",
    },
  ],

  // `pause_repo` is low/low/no-approval; `delete_integration` is
  // destructive/high/approval-required. The stricter source wins on every axis,
  // and it is the right one: this is the tool that can erase a repository's
  // history from the graph.
  agent: { requiresApproval: true, riskLevel: "high", category: "ingestion" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  // Both sources allowed workspace Member. That does not carry: §10.1 makes the
  // main repo the thing "a workspace without cannot exist", so unlinking is at
  // least as consequential as the owner-gated act of binding it.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Removes the link row, deregisters webhooks, and (with purgeData) deletes
  // graph nodes. Both sources mutate.
  mutates: true,

  input: z.object({
    // Carried from `pause_repo`, which is the source that addressed a repository
    // rather than a plugin instance.
    repoId: repoPause.input.shape.repoId,

    /**
     * Carried verbatim from `delete_integration`, including its default. §11.1:
     * entities hold `DERIVED_FROM → :SourceRecord` provenance, so a purge does
     * not just remove a repository's own nodes — it removes the evidence under
     * entities resolved across sources. Defaulting to false means an unlink is
     * reversible by re-linking; only an explicit true is not.
     */
    purgeData: integrationDelete.input.shape.purgeData,
  }),

  output: z.object({
    // Carried from `delete_integration`: the purge is a background job and the
    // caller gets its handle, not a finished deletion.
    jobId: integrationDelete.output.shape.jobId,
    status: integrationDelete.output.shape.status,
    purgeData: integrationDelete.output.shape.purgeData,

    repoId: z.string(),

    /**
     * §11.4 step 2 in reverse. Reported separately from the purge job because
     * event deregistration is synchronous and the purge is not: a caller needs
     * to know the repository has stopped feeding the graph even while the
     * deletion job is still running.
     */
    eventsUnsubscribed: z.boolean(),
  }),
});

export type UnlinkRepositoryInput = z.output<typeof unlinkRepository.input>;
export type UnlinkRepositoryOutput = z.output<typeof unlinkRepository.output>;
