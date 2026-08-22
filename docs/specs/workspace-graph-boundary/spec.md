# Oxagen code lineage and workspace-graph boundary

**Decision date:** 2026-07-20
**Status:** Approved — build in progress
**Repositories reviewed:** Oxagen, Stella, and `context-graph-protocol`

## Executive decision

The right model is not one code graph. It is **two graph planes joined by an immutable evidence bridge**:

1. **Stella owns the exact working-code graph.** It stays beside each checkout or worktree and follows the actual bytes the agent can see: symbols, lines, calls, imports, references, embeddings, dirty files, and candidate-only changes.
2. **Oxagen owns the governed workspace graph.** It stores a small, commit-addressed projection of shared repository structure: repository, canonical snapshot, domain/code-scope topology, ownership, policy, runs, context manifests, artifacts, commits, and pull requests.
3. **Oxagen's evidence ledger stores the exact bridge.** It retains immutable commit/file mutations, context-frame manifests, digests, approvals, tool receipts, and verification results. Exact file facts belong in evidence even when files are not first-class workspace-graph nodes.

The concise rule is:

> The detailed graph follows the worktree. The shared graph follows verified canonical commits. The evidence ledger follows every governed agent attempt.

Two important corrections to the main/default-branch instinct:

- Use an **immutable commit SHA observed at the configured default ref**, never the moving name `main`, as snapshot identity.
- Make shared topology canonical-ref-only, but do **not** make provenance main-only. Unmerged and rejected agent work still needs immutable run, changed-file, commit, PR, and verification evidence.

## The three data planes

### 1. Stella's local graph (stays local)

Keep local by default: full file/symbol/line/call/reference/import indexes; embeddings and retrieved source snippets; uncommitted and untracked source state; per-branch, per-worktree, and best-of-N candidate overlays; absolute filesystem paths; speculative or losing candidate graphs.

Attestable local generation identity (Stella-side; Oxagen consumes it in evidence):

```text
LocalCheckoutSnapshotV1
  repository_id
  base_commit_sha
  head_commit_sha?
  head_tree_sha?
  dirty_patch_digest
  untracked_manifest_digest
  graph_generation_id
  graph_schema_version
  extractor_version
  indexed_root_digest
  completed_at
  freshness_status
```

Branch names and local paths are annotations, not identity.

### 2. Oxagen's workspace graph (launch projection)

Include: `Repository` (provider's immutable repository ID), `RepositorySnapshot` (repository ID + commit SHA + tree SHA), `Domain`, a minimal stable `CodeScope` / versioned `DomainBinding` (package, service, module, or path prefix), aggregated domain/code-scope dependency edges for the canonical snapshot, `AgentVersion`, `Run`, `Attempt`, `ContextManifest`, `Artifact`, `Commit`, `PullRequest`, `Verification` lineage, and ownership/classification/policy/RBAC relationships.

Do NOT persist in the launch workspace graph: branch-specific `SourceFile` copies; symbols, lines, call sites, or references; source chunks or plaintext source embeddings; a graph per feature branch or worktree; arbitrary client-authored `is_system` nodes and edges.

Recommended relationships:

```text
Repository         -[:HAS_SNAPSHOT]-> RepositorySnapshot
RepositorySnapshot -[:BINDS_SCOPE]-> CodeScope
CodeScope          -[:BELONGS_TO]-> Domain
CodeScope          -[:DEPENDS_ON {evidence_digest, count}]-> CodeScope
AgentVersion       -[:EXECUTED]-> Run
Run                -[:BASED_ON]-> RepositorySnapshot
Run                -[:USED_CONTEXT]-> ContextManifest
Run                -[:PRODUCED]-> Artifact|Commit
Commit             -[:INTEGRATED_AS]-> RepositorySnapshot
Artifact|Commit    -[:AFFECTS]-> CodeScope|Domain
PullRequest        -[:MERGED_AS]-> Commit
```

### 3. The immutable evidence bridge

Store exact commit-addressed file mutations in the evidence ledger, without requiring every file to become a permanent Neo4j node:

```text
RunEvidenceManifestV1
  run_id
  attempt_id
  initiating_principal_id
  agent_principal_id
  agent_version_id
  authorization_snapshot_id
  local_checkout_snapshot

  context
    compiled_frame_manifest_digest
    frame[]
      provider_id
      frame_id
      uri
      canonical_content_digest
      local_graph_generation_id?
      authorization_decision_id
      retention_mode

  changes[]
    repository_id
    path_locator_or_tenant_hmac
    change_kind
    before_digest?
    after_digest?
    code_scope_id?
    domain_id?

  commits[]
  pull_request_receipts[]
  tool_receipts[]
  approval_receipts[]
  verification_receipts[]
  artifact_digests[]
  evidence_authority
```

Explicit authority levels (never merged into one undifferentiated "truth" edge):

- `runner_observed`: emitted by the Oxagen-hosted Stella engine and persisted by the durable runner;
- `provider_observed`: reconciled from GitHub, CI, or another authoritative provider;
- `client_attested`: uploaded by a standalone Stella client and not yet independently verified;
- `inferred`: domain or impact inference, always carrying model/method, input digest, confidence, and policy status.

## What may flow upward

| Data | Destination | Default |
|---|---|---|
| Repository provider ID, canonical ref, commit/tree/parent SHAs | Evidence ledger and workspace graph | Always |
| Local checkout and graph-generation digests | Run evidence | Always for governed coding runs |
| Agent, initiating principal, delegation, policy, and approval identities | Run evidence and workspace graph | Always |
| CGP frame ID, URI, provenance digest, provider, token cost, and authorization decision | Context manifest | Always for selected frames |
| Exact context content actually shown to the model | Tenant-encrypted blob evidence | Policy-controlled; required for content-exact replay |
| Changed paths, change type, before/after digest, commit and PR linkage | Evidence ledger | Always for mutations; path may be encrypted/HMAC'd |
| Domain/code-scope impact and aggregated dependencies | Workspace graph | Always for accepted canonical snapshots; provisional for local work |
| Full local code graph, source embeddings, dirty source tree | Nowhere central | Never by default |
| Absolute worktree path | Nowhere central | Never |

Replay tradeoff: hash-only retention gives **structural/verifiable replay** (identity and ordering), not content-exact replay. Content-exact replay requires retaining the exact authorized context slices used by the model, encrypted outside the graph.

## Canonical-ref policy

1. Discover the repository's configured default branch; do not hard-code `main`.
2. Treat only that ref as a canonical shared code channel.
3. Identify each projection by the immutable `after` commit SHA and tree SHA.
4. Optionally allow a small administrator-managed set of protected release refs later — each a separate canonical channel; never collapse them into a branchless graph.
5. Do not build shared topology for feature branches, merge-queue branches, Stella worktrees, or candidates.
6. Preserve evidence for agent-produced commits and PRs even when they never merge.

## GitHub projection lifecycle

The webhook is a trigger, not the source of truth.

### Initial connection

1. Bind one governed connection to an immutable GitHub repository ID and installation ID.
2. Resolve the verified default ref to a commit SHA.
3. Fetch and project the tree by that immutable SHA, not by a moving branch name.
4. Build a staged snapshot generation with coverage, exclusions, parser versions, errors, and truncation recorded.
5. Atomically activate it only after the generation is complete.

### Push to the canonical ref

1. Accept a signed GitHub delivery and retain its delivery ID.
2. Emit a dedicated `repository.ref_updated` event containing repository ID, ref, before SHA, after SHA, forced/deleted state, and observed time.
3. Deduplicate the projection by repository ID plus `after_sha`.
4. Re-fetch the authoritative ref/commit/tree from GitHub.
5. Apply a delta only when the stored head and event ancestry are consistent; otherwise reconcile the exact target tree.
6. Build off to the side, handle deletions and renames, validate coverage, then atomically advance `projected_head_sha`.
7. Keep serving the previous complete snapshot while the new one builds, but label it stale when `observed_head_sha != projected_head_sha`.

### Noncanonical branch or PR activity

- Do not mutate shared code topology.
- For an Oxagen/Stella run, record its checkout identity, changed-file manifest, commits, PR state, CI, and domain impact as evidence.
- Treat impact edges as `client_attested` or `inferred` until GitHub/CI observes them.
- On merge, link PR and run evidence to the merge commit. Advance shared topology only after the canonical ref is independently verified and projected.
- Closing or deleting a branch ends its ref observation; it never deletes historical run evidence.

Use a periodic ref reconciliation job as insurance against lost, duplicated, or out-of-order webhooks.

## Findings against the pre-change implementation

1. Initial sync resolved the default branch, fetched its recursive tree by the moving branch name, and fanned out per-file parsing without pinning to one immutable commit (`packages/inngest-functions/src/functions/ingestion.github-initial-sync.ts`).
2. GitHub push webhooks only became generic commit entity records — no changed-blob fetch, no deletion processing, no projection head advance (`apps/api/src/routes/v1/github-webhook.ts`, `packages/ingestion/src/connectors/github/index.ts`).
3. `SourceFile`, `SourceSymbol`, `SourceChunk` identities omitted commit SHA and were updated in place; plaintext chunks persisted in Neo4j (`packages/inngest-functions/src/functions/ingestion.github-parse-file.ts`).
4. The same source file had incompatible identities across GitHub ingestion, in-app lineage/locks, and client-authored code and lineage pushes.
5. `push_graph` was exposed through API and MCP to workspace Members, accepting arbitrary system labels, properties, edges, embeddings, and destructive tombstones, without enforcing idempotency key, repository binding, branch, or commit SHA (`packages/oxagen/src/contracts/graph.sync.push.ts`, `packages/handlers/src/graph.sync.push.ts`).
6. Client-side code push parsed the working tree but keyed its cursor/idempotency around `HEAD` with no clean-tree or canonical-ref requirement.
7. Domain classification is inferred and bounded — it must retain source, input snapshot, confidence, model/method, and coverage rather than becoming authoritative RBAC truth by itself.
8. Stella's local index identifies files by mutable path and content hash, not repository/checkout/generation — it needs the snapshot/generation barrier before frame provenance is attestable.

## What to delete or replace

Delete or disable for launch:

- the public/API/MCP `push_graph` capability;
- client-authored graph and lineage up-sync;
- fire-and-forget in-app `GraphSyncProvider` writes;
- centrally persisted feature-branch source graphs;
- workspace-graph `SourceSymbol`, `SourceChunk`, line/call/reference detail, and plaintext code embeddings/content;
- client-authored system labels, arbitrary relationship types, and tombstones;
- auto-materialized LLM domain/feature/semantic edges as unquestioned truth.

Keep and reshape:

- GitHub App installation auth and HMAC webhook verification;
- repository, commit, PR, CI, and release provider ingestion;
- the deterministic parser as a transient canonical-snapshot projector if useful for domain/code-scope aggregation;
- a Postgres projection-generation manifest and immutable event ledger as canonical truth;
- Neo4j only as a rebuildable, RBAC-filtered workspace projection;
- a narrow, authenticated `RunEvidenceManifestV1` ingestion path for Stella, distinct from generic graph mutation.

## Launch invariants

1. Every shared code fact names a repository snapshot commit/tree SHA.
2. Every query returns projection revision, freshness, and coverage.
3. No incomplete projection can become active.
4. No client can author canonical provider-observed or runner-observed evidence.
5. Every exact local code locator maps either to a versioned code scope/domain or to `unresolved`; it never silently maps to the current default ref.
6. Every run records the local checkout and graph generation that framed it.
7. Every selected CGP frame records provenance, content digest, authorization decision, and retention mode.
8. Every mutating run records file-level before/after evidence somewhere, even when the workspace graph presents only domain-level topology.
9. Canonical topology advances only from verified provider observations.
10. Exact replay is claimed only when the exact retained context and action inputs are available.
