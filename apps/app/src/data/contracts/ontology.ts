// The Ontology page: model map, sources, repositories, versions and embedding
// indexes (spec §11, App. A.3 `wrk.repositories`).
import { z } from "zod";
import { CommitSha, Count, Instant, Ratio } from "./common";

export const OntologyClass = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  entityCount: Count,
  freshAt: Instant,
  sources: z.array(z.string()),
  relations: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  // `classes` is wired at M0 (plan §3.1 🟡); these counts need stores that do
  // not exist yet, so null means not recorded, never zero.
  /** Agents whose context cited the class. Null until `USED_CONTEXT` edges are recorded (G10). */
  citedByAgents: Count.nullable(),
  rulesReferencing: Count,
  /** Proven runs that touched the class. Null until verdicts are recorded (G7). */
  provenRuns: Count.nullable(),
  /** Open drift findings. Null until the findings job runs (G4). */
  driftFindings: Count.nullable(),
  builtin: z.boolean(),
});
export type OntologyClass = z.infer<typeof OntologyClass>;

export const SyncHealth = z.enum(["ok", "degraded", "failed"]);
export type SyncHealth = z.infer<typeof SyncHealth>;

export const Source = z.object({
  name: z.string(),
  kind: z.enum(["github", "linear", "postgres"]),
  records: Count,
  lastSyncAt: Instant,
  health: SyncHealth,
  cursor: z.string(),
  entities: z.array(z.string()),
});
export type Source = z.infer<typeof Source>;

export const Repository = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** One `main` per workspace; the rest are `linked`. */
  role: z.enum(["main", "linked"]),
  productionBranch: z.string(),
  lastIndexedSha: CommitSha,
  lastIndexedAt: Instant,
  issues: z.object({ enabled: z.boolean(), imported: Count }),
  events: z.object({
    health: SyncHealth,
    deliveries30d: Count,
    gaps: Count,
    gapsRecovered: Count,
  }),
  symbols: Count,
  dataLayerDrift: Count,
});
export type Repository = z.infer<typeof Repository>;

export const OntologyVersion = z.object({
  version: z.string().regex(/^v\d+$/),
  status: z.enum(["active", "superseded", "proposed"]),
  /** Null while the proposal is unmerged. */
  commitSha: CommitSha.nullable(),
  at: Instant,
  /** A person's id, or null when the ontology engine proposed it. */
  authoredById: z.string().nullable(),
  pullRequestRef: z.string(),
  diffSummary: z.string(),
});
export type OntologyVersion = z.infer<typeof OntologyVersion>;

export const EmbeddingIndex = z.object({
  name: z.string(),
  model: z.string(),
  dimensions: Count,
  nodes: Count,
  recall: Ratio,
  citationRate: Ratio,
  status: z.enum(["current", "upgrade_available"]),
});
export type EmbeddingIndex = z.infer<typeof EmbeddingIndex>;
