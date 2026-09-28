# ADR-214: Server-built code graph copies hold symbols, chunks, and embeddings

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** platform, knowledge
- **Supersedes in part:** the "Do NOT persist" list in
  `docs/specs/workspace-graph-boundary/spec.md` §2 (decided 2026-07-20), the
  2026-07-21 supersession note on ADR-016 where it retires a server-side exact
  code graph, and ADR-003's "`pgvector` is not used" for the code graph only.
- **Related:** the code graph spec (`codegraph-spec.html` and
  `codegraph-build-plan.md` in `macanderson/oxagen-roadmap`, PR
  macanderson/oxagen-roadmap#195), ADR-018 (CLI sync, revoked), ADR-042
  (tenant data planes), ADR-194 (every embedding is voyage-4-large on one
  platform key).

> **Amended 2026-09-28 by [ADR-220](./ADR-220-the-code-graph-builds-on-the-operators-machine-and-a-workspace-may-name-its-embedding-endpoint.md) (proposed).** Decision 4 gains two more modes, embeddings off and the workspace's own endpoint. Decision 1 stands: the local code graph ADR-220 adds lives only on the operator's machine and never writes the shared graph.

## Context

The workspace-graph boundary spec split code knowledge into two planes.
Stella keeps the exact working-code graph beside each checkout. Oxagen keeps
only a small projection: repositories, snapshots, code scopes, domains, and
aggregated dependencies. Its list of things Oxagen must not persist names
symbols, lines, call sites, references, source chunks, and plaintext source
embeddings. ADR-016's supersession note says the same thing from the other
side: the server-side exact code graph does not survive.

That split answered the defects the boundary review found in July. The CLI
pushed working-tree graphs keyed by mutable paths. `push_graph` let any
member write arbitrary nodes, edges, and tombstones. Symbols were updated in
place with no commit SHA, and feature-branch graphs piled up in Neo4j.

The code graph spec needs what that list forbids. Its questions (what breaks
if a column is dropped, which tests cover a function, which spec a change
implements) walk from a route to a symbol to a column to a test across every
repo in a workspace. A projection of scopes and domains cannot answer them,
and neither can a graph that lives only in one developer's checkout.

The code graph does not reopen the July defects:

- Oxagen builds every copy itself, from the provider's repository at an
  immutable commit SHA. No client writes to it.
- A copy is fixed once published. The next commit makes a new copy.
- Only three kinds of copy exist: the default branch, tagged releases, and
  open PRs. PR copies are overlays that expire 7 days after the PR closes.
  No worktree or local branch reaches Oxagen.
- Every answer names its commits, its freshness, and its coverage, and no
  incomplete copy goes live.

Those four points are the boundary spec's own launch invariants 1 to 4.

## Decision

1. **Oxagen may store symbols, references, call sites, source chunks, and
   embeddings of source text for code graph copies it builds.** That covers
   copies of the default branch, tagged releases, and open PRs, built by the
   code graph pipeline from the provider at a commit SHA. It covers nothing
   else. The rest of the boundary spec stands. Stella's working-tree graph
   stays local. No client writes the shared graph. No graph is kept for a
   feature branch or a worktree.
2. **The code graph's relationships live in Postgres and in S3 graph files,
   not Neo4j.** A copy never changes after it is published, and one repo's
   copy fits in memory. A fixed file read from memory answers a two-step walk
   in a few memory reads. Postgres rows keep the lasting record, valid over a
   range of copies, so unchanged nodes are never copied. This is an exception
   to the storage table in `AGENTS.md`, which puts graph relationships in
   Neo4j. Neo4j keeps every graph it holds today, including the workspace
   ontology and agent memory.
3. **The code graph's vectors live in pgvector.** Search needs vector,
   full-text, and relational filters in one query, and the code graph's
   rows are already in Postgres. ADR-003 still governs every other vector:
   documents, memories, and messages stay in Neo4j.
4. **Embeddings follow ADR-194.** Code graph cards are embedded with
   `voyage-4-large` at 1,024 dimensions, through Voyage's API on the platform
   key, and each embedding is metered and billed. A later ADR can move them
   to another route. The code graph spec's plan to send them through
   OpenRouter on the organization's key does not override ADR-194.
5. **Data stays on the organization's data plane.** Tables are reached
   through `resolveDataPlane()` (ADR-042) and `withTenantDb`, with
   row-level security by workspace. Graph files in S3 use SSE-KMS with the
   customer's key. Every file, chunk, card, and prompt passes a secret scanner
   before it is stored, embedded, or sent to a model.
6. **The code graph reuses Stella's graph code instead of writing it again.**
   Stella's `stella-graph` crate already extracts symbols, imports, call sites,
   storage schemas (Prisma, Python ORMs, SQL, TypeScript), manifests, and
   markdown for 13 languages. Its extraction moves into a crate with no
   database and no I/O, which Stella's local index and Oxagen's server builder
   both call. New readers that work on one file (environment variables, tests,
   scripts, CI files, infrastructure files) go into that crate too, so Stella's
   local graph gains them. Oxagen keeps only what needs a server: Postgres and
   S3 storage, SCIP runs, history, ranking, domains, the workspace stage,
   linker agents, and the query service. One extractor also means a symbol has
   the same ID in Stella's local graph and in Oxagen's graph. Stella is
   AGPL-3.0-only, so Oxagen links these crates under the commercial license
   that Stella's contributor agreement lets Mac grant, pinned to a Stella
   release tag. Mac approved that license on 2026-09-28.

## Consequences

- `docs/specs/workspace-graph-boundary/spec.md` carries a dated amendment
  that points here. ADR-016's note and ADR-003 carry the same.
- `AGENTS.md` names the exception beside its storage table, so the storage
  rule stays true for every other feature.
- The code graph build can start. Its first batch no longer needs to write
  this decision.
- Stella's graph crate splits in two, and Stella's own review rules apply to
  every reader added there. Oxagen upgrades by moving its pinned tag.
- Oxagen now holds customer source text and derived facts in a new place.
  The access rules in the code graph spec apply: answers prune repos the
  caller cannot read before a walk expands them, and derived text such as a
  domain brief is shown only to callers who can read every repo it came from.
- Deleting a repo from a workspace deletes every row, file, and vector the
  code graph holds for it.

## Alternatives considered

- **Keep the boundary and answer from Stella's local graph.** Each answer
  would cover one checkout and one repo, would differ between developers, and
  could not reach tables, infrastructure, or specs in other repos. The code
  graph exists to answer across all of them.
- **Store the code graph in Neo4j.** It would keep the storage table
  unchanged. Every copy would become millions of mutable graph rows, a
  two-step walk would be a database round trip instead of memory reads, and
  the July defects came from exactly that pattern.
- **Store only hashes and fetch source on demand.** Search by meaning and by
  word needs indexed text, and a fetch per answer would put the provider's
  rate limit on every query.
