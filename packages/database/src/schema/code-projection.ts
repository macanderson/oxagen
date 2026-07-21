import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ingestionSchema } from "./_schemas";
import {
  appendOnlyAuditMixin,
  auditMixin,
  idMixin,
  orgScopeMixin,
} from "./_mixins";

// ── Oxagen's governed workspace-graph code projection (Postgres = canonical
// truth) ──────────────────────────────────────────────────────────────────────
//
// Postgres holds the small, commit-addressed projection of shared repository
// structure that the RBAC-filtered Neo4j workspace projection is REBUILT from —
// never the reverse (docs/specs/workspace-graph-boundary/spec.md §"The three
// data planes", §"Launch invariants"). Exact working-code detail (symbols,
// lines, dirty files, embeddings) stays in Stella's local graph and NEVER lands
// here; only repository identity, canonical snapshots, projection generations,
// and a minimal stable code-scope topology.
//
// Lives in the `ingestion` schema beside `source_connections` and
// `github_installations` (its upstream): a repository projection is downstream
// of the governed GitHub connection that feeds it. This deliberately reuses the
// existing schema rather than minting a new one, mirroring
// 20260804100000_agent_runs_durable_schema.sql ("no CREATE SCHEMA needed").
//
// Every table carries org_id + workspace_id (via orgScopeMixin) — not because a
// snapshot is workspace-private, but because the shared `tenant_isolation` RLS
// policy keys on those columns; the same reason agent_run_events carries them as
// a child of agent_runs. Cross-file / cross-schema links (→ source_connections)
// are app-enforced plain uuids per the storage rules; within-file parent→child
// links (snapshot/generation/scope → repository) use real FKs.

// ── ingestion.code_repositories ───────────────────────────────────────────────
//
// One row per governed repository. Identity is the provider's IMMUTABLE
// repository ID (never the owner/name, which can be renamed under you). Freshness
// is DERIVED, never stored: observed_head_sha != projected_head_sha ⇒ stale
// (spec §"Push to the canonical ref" step 7). default_ref is DISCOVERED from the
// provider (spec canonical-ref policy step 1), never hard-coded to `main`.
export const codeRepositories = ingestionSchema.table(
  "code_repositories",
  {
    ...idMixin("crepo"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // Provider of record for this repository. Only 'github' at launch; the CHECK
    // gates the vocabulary ahead of GitLab/Bitbucket connectors.
    provider: text("provider").notNull(),
    // The provider's immutable repository ID (GitHub's numeric repo id as text).
    // Stable across owner/name renames — the true identity of the repository.
    providerRepoId: text("provider_repo_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    // GitHub App installation id (text for parity with github_installations).
    installationId: text("installation_id"),
    // Governed connection that feeds this projection. Cross-file (ingestion.ts)
    // link — app-enforced plain uuid, not a DB FK (storage rules).
    sourceConnectionId: uuid("source_connection_id"),
    // The DISCOVERED default ref (e.g. 'refs/heads/main'). The only canonical
    // shared code channel; snapshots are identified by the SHA at this ref, not
    // by the moving branch name.
    defaultRef: text("default_ref").notNull(),
    // Latest head SHA seen at default_ref via webhook/reconcile (the "observed"
    // side of freshness).
    observedHeadSha: text("observed_head_sha"),
    // Latest head SHA whose projection generation is fully built + active (the
    // "projected" side of freshness). Advances atomically after a generation
    // completes.
    projectedHeadSha: text("projected_head_sha"),
  },
  (t) => ({
    // The provider's immutable repo id is unique per org+provider — a second
    // tenant binding the same GitHub repo gets its own governed row.
    orgProviderRepoUniq: unique("code_repositories_org_provider_repo_uq").on(
      t.orgId,
      t.provider,
      t.providerRepoId,
    ),
    workspaceOrgIdx: index("code_repositories_workspace_org_idx").on(
      t.workspaceId,
      t.orgId,
    ),
    sourceConnectionIdx: index("code_repositories_source_connection_idx").on(
      t.sourceConnectionId,
    ),
    providerCheck: check(
      "code_repositories_provider_check",
      sql`${t.provider} IN ('github')`,
    ),
  }),
);

// ── ingestion.repository_snapshots ─────────────────────────────────────────────
//
// Append-only. One immutable snapshot per (repository, commit). Snapshot
// identity is the commit SHA + tree SHA observed at the canonical ref (launch
// invariant 1: "Every shared code fact names a repository snapshot commit/tree
// SHA"). Never updated in place.
export const repositorySnapshots = ingestionSchema.table(
  "repository_snapshots",
  {
    ...idMixin("snap"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => codeRepositories.id),
    commitSha: text("commit_sha").notNull(),
    treeSha: text("tree_sha").notNull(),
    // Parent commit SHAs (jsonb array, order preserved). Empty for a root commit.
    parentShas: jsonb("parent_shas")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // Who observed this commit: the durable Oxagen runner ('runner_observed') or
    // a reconciled provider read ('provider_observed'). Distinct authority levels
    // are never collapsed (spec §"The immutable evidence bridge").
    source: text("source").notNull(),
  },
  (t) => ({
    repositoryCommitUniq: unique("repository_snapshots_repo_commit_uq").on(
      t.repositoryId,
      t.commitSha,
    ),
    repositoryIdx: index("repository_snapshots_repository_idx").on(
      t.repositoryId,
    ),
    sourceCheck: check(
      "repository_snapshots_source_check",
      sql`${t.source} IN ('provider_observed', 'runner_observed')`,
    ),
  }),
);

// ── ingestion.repository_ref_observations ──────────────────────────────────────
//
// Append-only dedupe ledger for canonical-ref updates (spec §"Push to the
// canonical ref"). Each signed GitHub delivery — or a synthetic
// 'reconcile:<sha>' from the periodic ref reconciliation job — is retained by
// its delivery id so a lost/duplicated/out-of-order webhook is idempotent.
export const repositoryRefObservations = ingestionSchema.table(
  "repository_ref_observations",
  {
    ...idMixin("refobs"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => codeRepositories.id),
    ref: text("ref").notNull(),
    beforeSha: text("before_sha"),
    afterSha: text("after_sha"),
    forced: boolean("forced").notNull().default(false),
    deleted: boolean("deleted").notNull().default(false),
    // GitHub delivery GUID, or a synthetic 'reconcile:…' id from the
    // reconciliation job. UNIQUE — the dedupe key for at-least-once webhooks.
    deliveryId: text("delivery_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    deliveryIdUniq: unique("repository_ref_observations_delivery_id_uq").on(
      t.deliveryId,
    ),
    repositoryIdx: index("repository_ref_observations_repository_idx").on(
      t.repositoryId,
    ),
  }),
);

// ── ingestion.projection_generations ───────────────────────────────────────────
//
// A staged snapshot projection build (spec §"GitHub projection lifecycle").
// Built off to the side with coverage/exclusions/parser-version/errors/
// truncation recorded, then ATOMICALLY activated only when complete (launch
// invariant 3: "No incomplete projection can become active"). Mutable during the
// build (status transitions, file counters), so it carries updated_at.
export const projectionGenerations = ingestionSchema.table(
  "projection_generations",
  {
    ...idMixin("gen"),
    ...auditMixin(),
    ...orgScopeMixin(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => codeRepositories.id),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => repositorySnapshots.id),
    status: text("status").notNull().default("building"),
    filesTotal: integer("files_total").notNull().default(0),
    filesProcessed: integer("files_processed").notNull().default(0),
    filesSkipped: integer("files_skipped").notNull().default(0),
    truncated: boolean("truncated").notNull().default(false),
    parserVersion: text("parser_version"),
    // Structured build error (message, failing path, cause) — null on success.
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Set only when this generation is atomically promoted to 'active'.
    activatedAt: timestamp("activated_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    // Dedupe-by-after-sha: one generation per (repository, snapshot). A repeated
    // push for a SHA already generated collapses onto the existing row.
    repositorySnapshotUniq: unique(
      "projection_generations_repo_snapshot_uq",
    ).on(t.repositoryId, t.snapshotId),
    // Partial unique index: at most one ACTIVE generation per repository (the
    // served projection). `unique()` has no WHERE clause, so a partial
    // `uniqueIndex(...).where(...)` is the supported form.
    activePerRepositoryUniq: uniqueIndex(
      "projection_generations_one_active_per_repo_uq",
    )
      .on(t.repositoryId)
      .where(sql`${t.status} = 'active'`),
    repositoryIdx: index("projection_generations_repository_idx").on(
      t.repositoryId,
    ),
    statusCheck: check(
      "projection_generations_status_check",
      sql`${t.status} IN ('building', 'active', 'failed', 'superseded')`,
    ),
  }),
);

// ── ingestion.code_scopes ──────────────────────────────────────────────────────
//
// The minimal stable CodeScope topology for one generation (spec §"Oxagen's
// workspace graph"): a package / service / module / path-prefix key. Domain
// binding is a nullable slug, NOT an FK — no `domains` table exists at launch,
// and domain classification is inferred/bounded, never authoritative RBAC truth
// on its own (spec findings §7). Immutable within its generation.
export const codeScopes = ingestionSchema.table(
  "code_scopes",
  {
    ...idMixin("scope"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => codeRepositories.id),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => projectionGenerations.id),
    // Stable path-prefix / package key, e.g. 'packages/billing'.
    scopeKey: text("scope_key").notNull(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    // Nullable domain slug — no domains table at launch; provisional, inferred.
    domainSlug: text("domain_slug"),
    fileCount: integer("file_count").notNull().default(0),
  },
  (t) => ({
    generationScopeUniq: unique("code_scopes_generation_scope_uq").on(
      t.generationId,
      t.scopeKey,
    ),
    repositoryIdx: index("code_scopes_repository_idx").on(t.repositoryId),
    generationIdx: index("code_scopes_generation_idx").on(t.generationId),
    kindCheck: check(
      "code_scopes_kind_check",
      sql`${t.kind} IN ('package', 'service', 'module', 'path')`,
    ),
  }),
);
