# ADR-220: The code graph builds on the operator's machine, and a workspace may name its embedding endpoint

- **Status:** Proposed
- **Date:** 2026-09-28
- **Owners:** platform, knowledge, tacho
- **Decided by:** Mac set the direction on 2026-09-28. This record awaits
  acceptance.
- **Amends:** ADR-214 decision 4 and ADR-194 decision 2, for the code graph
  only. ADR-016, whose local path returns under tachod.
- **Related:** issues #4657 and #4662, ADR-042 (tenant data planes), ADR-053 §2
  (organization model keys), ADR-101 (four harnesses), ADR-187 (the gateways),
  ADR-211 (no HTTP+SSE), and the code graph spec version 1.2
  (`codegraph-spec.html` and `codegraph-build-plan.md` in
  `macanderson/oxagen-roadmap`, branch `docs/codegraph-local-mcp`).

## Context

ADR-214 lets Oxagen build code graph copies of the default branch, tagged
releases, and open PRs. Those copies answer questions about committed code. An
operator in a checkout asks about the code in front of them: files not yet
committed, and a branch no PR covers yet. The cloud copy cannot see that code,
and ADR-214 keeps it that way on purpose. No client writes the shared graph,
and Oxagen keeps no graph of a feature branch or a worktree.

Mac asked for three additions on 2026-09-28:

- An operator builds a code graph of their checkout with the `oxagen` CLI. It
  is the MCP endpoint for code graph questions on that machine, it indexes
  whatever the machine holds when it starts, and it writes local tables, not
  cloud ones.
- A workspace can store credentials and settings for its own embedding
  provider. With no provider, the graph is not searchable by meaning.
- An `enable_embeddings` switch whose help text says the workspace is billed
  for the embeddings each release generates. Every merge commit to the default
  branch is built by the same code, and every release keeps its own copy.

ADR-194 decision 2 says an organization's own key never serves an embedding.
ADR-214 decision 4 puts every code graph embedding on `voyage-4-large` on the
platform key. ADR-016 wanted a live local graph, and its local daemon and cloud
sync were retired on 2026-07-21, because the CLI pushed working-tree graphs
into the shared store. A local graph has to avoid that path.

## Decision

1. **One pipeline, two hosts.** The code graph's steps are written against two
   interfaces in `cg-core`: a `Store` for nodes, edges, vectors, and graph
   files, and a `Queue` that runs steps, saves their output, and retries them.
   The cloud host implements them with Postgres, S3, and Inngest. The local
   host is the `codegraph` binary, which implements them with one SQLite file
   per repo and a durable jobs table. Both call the extraction crate from
   ADR-214 decision 6 at the same version, so a clean checkout's local graph
   and the cloud copy of that commit hold the same nodes, edges, and IDs. The
   steps that need the whole workspace or a model (schema reads through
   sqlglot, domain grouping, and enrichment) do not run locally. Their facts
   come from the cloud copy of the checkout's base: the newest commit on the
   default branch that `HEAD` contains and that has a finished copy. The local
   graph drops those facts for every file the checkout changed since its base
   and marks them missing, so a renamed or deleted symbol never carries a
   stale fact. The pin names the base. When no built commit is an ancestor of
   `HEAD`, the local graph carries none of these facts and marks them missing.
2. **The local graph lives only on the operator's machine.**
   `oxagen codegraph init` indexes the working tree as it is, uncommitted
   changes included. The result is named by its pin: the `HEAD` commit, a
   SHA-256 digest of the changed paths and contents, and the base commit its
   cloud facts come from (decision 1). It writes
   `~/.oxagen/codegraph/<repo-id>/graph.db` and nothing else. A local build
   stores no code, card, card hash, or vector in the cloud. Its embedding
   vectors stay in `graph.db` (decision 6). For a local build, the embedding
   route records only the token count Oxagen bills in the Oxagen mode.
   The shared graph comes only from ADR-214's server builds. ADR-214
   decision 1 stands: Oxagen keeps no graph of a feature branch or a
   worktree, and the local graph is not a graph Oxagen keeps.
3. **Tachod serves it.** Tachod supervises the `codegraph` binary as the MCP
   server `codegraph`, over stdio or streamable HTTP on loopback, never
   HTTP+SSE (ADR-211). An HTTP call carries the token in
   `~/.oxagen/codegraph/token`, which is mode 0600. The server is the one code
   graph endpoint on the machine. It answers from the local tables where it
   can and sends every other question to the cloud query service as a governed
   read under the operator's identity. Every answer names its source, `local`
   or `cloud`. `init` writes the MCP entry for Claude Code, Codex, Cursor, and
   Stella (ADR-101). This takes the place of ADR-016's CLI daemon. ADR-016's
   cloud sync stays retired.
4. **Embeddings have three modes, set per workspace in
   `codegraph/embeddings.toml`.**
   - **Off** (`enable_embeddings = false`), the default. Search matches names
     and text, and nothing goes to an embedding provider.
   - **Oxagen** (`provider = "oxagen"`). ADR-194 and ADR-214 decision 4 hold:
     `voyage-4-large` at 1,024 dimensions on the platform key, billed per
     token.
   - **Your endpoint** (`provider = "custom"`). The workspace names an endpoint
     that speaks the OpenAI embeddings API, a model, and a stored credential.
     Oxagen bills no embedding tokens in this mode. The vectors form their own
     embedding space, stored as `halfvec` up to 4,000 dimensions with one
     partial HNSW index per space, and never mix with Voyage vectors.

   This amends ADR-194 decision 2 for the code graph alone. Every other
   embedding still goes to Voyage on the platform key, with one more
   exception. Under
   [ADR-217](./ADR-217-a-search-mode-server-ranks-its-tools-by-the-workspaces-embedding-provider.md),
   a `custom` provider in a workspace's `[embeddings]` table also sends a
   search-mode server's tool entries off the platform key.
5. **The endpoint credential belongs to one workspace and one embedding
   space, and is stored like a model credential.** `set_model_credential`
   gains a `purpose`. With `purpose: "embeddings"` it also takes a workspace,
   and the slot is keyed by organization, workspace, purpose, and embedding
   space (decision 6). Two workspaces with different endpoints hold two
   credentials. Setting one never replaces another workspace's credential or
   the organization's language-model key. A copy embeds its queries in the
   space it was built in, so a workspace that moves to a new endpoint gets a
   new slot, which becomes its active one, and the old slot stays for the
   copies decision 7 keeps. Rotating the key of the same endpoint and model
   replaces the key in its slot. An Owner or Admin can delete an old slot.
   Copies in that space then search by name and text, and their answers say
   `embeddings: space_retired`. The row sits in `org.model_credentials` under
   the same KMS envelope, which gains `purpose`, a nullable `workspace_id`,
   and a nullable embedding space. Only an org Owner or Admin sets it, and
   each change is audited as a security event, as today. The endpoint
   URL passes the same public-URL check as today's `baseUrl`. A loopback
   endpoint (`--embed-url http://127.0.0.1:11434/v1/embeddings`) is set only
   on the machine and is never stored in Oxagen.
6. **Cloud builds embed a card once per embedding space, and a local build
   caches its vectors only on its machine.** An embedding space is named by
   its endpoint URL, model, and dimensions. The Oxagen mode is one space, and
   two workspaces that name the same endpoint and model share another. In the
   Oxagen mode and with a stored endpoint, builds send cards through the code
   graph's embedding route, and a local build reaches it through tachod. That
   route runs in the code graph's query service until ADR-187 is accepted,
   then moves to the cloud gateway. Before it calls a provider, it looks up
   each card hash in the organization's `embeddings` table for that space.
   Every card passes ADR-214 decision 5's secret scanner before it leaves the
   machine.
   - **A cloud build writes the table.** When the caller is the cloud build
     host, the route stores each new vector and card hash in the
     `embeddings` table. A card from committed code is embedded once per
     space, whichever commit produced it.
   - **A local build only reads the table.** For a call that arrives through
     tachod under an operator's identity, the route returns a hit from the
     table, sends a miss to the provider, and returns the new vector without
     storing it or the card. The local host caches every vector it receives
     by card hash in `graph.db` and stores it nowhere else. The route decides
     by the caller's identity, not by a flag the client sends, so an
     operator's machine cannot write vectors for any card hash into the
     organization's cache. The lookup sends a card hash, and the card text
     already reaches the route on its way to the provider, so the lookup
     discloses nothing the embedding call does not.
   - **A loopback endpoint never uses the route.** The local host calls it
     directly and caches its vectors by card hash in `graph.db`, and on that
     machine it overrides the workspace's mode. A question the local server
     forwards to the cloud then searches by name and text, because the cloud
     holds no vectors in the loopback space, and the answer says so.

   A build in the custom mode with no stored credential still publishes,
   without vectors, and marks the copy `embeddings: missing_credential`.
7. **Every commit on the default branch gets its own copy, and every release
   is kept.** Commits on the default branch build in order. A squash merge
   lands one commit, and a rebase merge lands several, each of which builds.
   Each build starts from the copy before it and reprocesses only the files
   its commit changed, so a burst of merges costs the files they changed, not
   a full build each. `at: "<sha>"` answers from that commit's copy and never
   from a later one. A commit whose build has not finished answers `building`.
   The workspace stage, domain grouping, and enrichment run at most once
   every 5 minutes. Each copy names the run
   of those stages it carries, as part of its freshness. A tag builds its
   exact commit, is keyed by tag so a newer commit cannot cancel it, and is
   kept forever. The release archive lists each tagged copy with the builds
   since the last tag and the embedding tokens they used. Every query takes
   an optional `at`: a commit on the default branch, a tag, or a PR number. A
   PR number means the copy of that PR's latest push. A PR branch's own
   commits are not addressable.

## Consequences

- An operator gets answers about uncommitted code from any of the four
  harnesses, and the shared graph still changes only through server builds of
  the provider's commits.
- The default branch builds once per commit. Each build reprocesses only the
  files its commit changed, and the workspace stage, domain grouping, and
  enrichment still run at most once every 5 minutes.
- A laptop now runs builds. The local host runs one worker at low priority
  with a 2 GB memory limit by default, and it runs SCIP only when
  `init --scip` asks for it.
- Any process running as the operator can read the token file and call the
  local server. That is the same trust boundary as the checkout itself, and
  the token never leaves the machine.
- Local and cloud answers can differ. Every answer carries `source`, and a
  local answer carries its pin, so a caller can tell which graph answered.
- In the custom mode, the customer's provider sets the quality and retention
  of embeddings. Oxagen stores the vectors and card hashes from cloud builds.
- A local build pays for every card no cloud build has embedded. Two
  operators who embed the same card from uncommitted work each pay for it,
  because neither build writes the organization's cache. Once the card is
  committed and a cloud build embeds it, later local builds read it from the
  table.
- The `codegraph` binary ships the Stella extraction crate to customer
  machines. ADR-214 records a commercial license for Oxagen to link that
  crate. Mac confirmed on 2026-09-28 that the grant covers shipping the crate
  inside the `codegraph` binary that customers run on their own machines.
- Stella's own index and the Oxagen local graph can both index one checkout on
  one machine. They share the extraction crate and its IDs but no files, so the
  cost is a second index, not a second set of IDs. Whether Stella reads the
  Oxagen local graph instead is left to a later decision.
- The workspace settings screen shows an "Enable embeddings" checkbox. Its
  help text names who bills the embeddings and every build that generates
  them: each commit on the default branch, each tagged release, each open PR,
  and each local graph that uses the workspace's mode. The code graph spec
  holds the exact strings. The release archive counts every build's tokens
  toward the release that follows it, so a bill line can still name a
  release.
- A workspace that changes endpoints keeps one credential per old space
  while it keeps copies built there. The settings screen lists each old slot
  with the copies that use it.

## Alternatives considered

- **Push local graphs to the cloud.** That is ADR-016's retired path, and it
  brings back the July defects ADR-214 lists.
- **Let a local build write the organization's `embeddings` table.** Two
  machines would stop paying twice for one uncommitted card. The table would
  then hold vectors of code Oxagen keeps no graph of, which breaks
  decision 2, and an operator's machine could write a vector for any card
  hash into the cache every build in the organization reads. Mac ruled on
  2026-09-28, in #4662, that local embeddings are cached locally only.
- **Build locally with a separate, lighter pipeline.** Two pipelines drift. A
  symbol would get one ID locally and another in the cloud, and no local answer
  could be checked against a copy.
- **Answer only from the cloud copy.** It cannot see uncommitted work.
- **Build one copy for a burst of merges.** A query at an earlier merge would
  read a later merge's code, and ADR-214 makes each commit its own copy.
- **One embedding credential per organization.** Two workspaces with
  different endpoints would overwrite each other's key, and one of them would
  send its cards to the other's provider.
- **Re-embed kept copies when a workspace changes endpoints.** Every kept tag
  would pay the new provider again at each switch, and old copies would stay
  unsearchable by meaning until the work finished.
- **Take imported facts from the newest cloud copy.** A checkout behind the
  default branch would show facts about symbols its own code renamed or
  deleted, and its pin could not show the mismatch.
- **Let a custom endpoint write into the Oxagen embedding space.** Vectors from
  two models cannot share an index or be compared. Separate spaces keep each
  index correct, and a workspace that switches back keeps its Voyage vectors.
- **Turn embeddings on by default.** Every workspace would pay for embeddings
  it did not ask for. With embeddings off by default, a bill appears only after
  someone checks the box and reads its help text.
