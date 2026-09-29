# ADR-217: A search-mode server ranks its tools by the workspace's embedding provider

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** mcp
- **Amends:** ADR-194 decision 2, and the rule in `AGENTS.md` that every
  model call goes through `@oxagen/ai`, for search entries alone.
- **Related:** issue #4580 (lane M15), PR #4632 (served tools),
  `mcp-studio-spec`, Large servers.

## Context

A steering record can put an MCP server in search mode. The agent then sees
three tools for that server (`search`, `describe`, and `call`) in place of
its whole tool list. `search` ranks the server's tools against the agent's
query and returns one line per tool.

Keyword ranking misses a query that shares no word with the tool's line. The
query "give money back" finds nothing, although `create_refund` is the tool
the agent wants. Embeddings rank that query correctly.

`workspace.toml` already carries an `[embeddings]` table, and the steering
sync copies it to `workspaces.settings.embeddings`. It names one of three
providers: `oxagen` (the default), `custom`, or `keyword`.

Two rules stand in the way:

- ADR-194 decision 2 says an organization's own key never serves an
  embedding. A `custom` provider is the workspace's own endpoint, model, and
  key.
- `AGENTS.md` routes every model call through `@oxagen/ai`. `@oxagen/ai`
  embeds with one model on one key, and a failure there answers 503
  (`EmbeddingUnavailableError`). Search must rank by keyword instead of
  failing.

## Decision

1. **Search entries embed outside `@oxagen/ai`.** `httpEmbedder` in
   `packages/mcp-studio/src/search/embedder.ts` posts `{model, input}` to
   the provider through MCP Studio's cloud transport. It accepts Voyage AI's
   answer shape, which OpenAI's also fits.
2. **The workspace's `[embeddings]` table picks the provider.**
   - `oxagen`, or no table: `voyage-4-large` at Voyage AI's endpoint on
     `VOYAGE_API_KEY`, the key ADR-194 names. The request sends
     `input_type`.
   - `custom`: the `url` and `model` the table names, with the credential
     `oxagen:credential/<name>` it names, decrypted from the workspace's
     credentials. An endpoint that takes no key leaves `credential` unset.
     The request sends no `input_type`.
   - `keyword`: nothing is sent to any provider.
   - A table that does not parse ranks by keyword and sends nothing.
3. **A vector is keyed by its target and its line.** The target key is the
   first 32 hex characters of the SHA-256 of the provider, url, and model.
   The content hash is the SHA-256 of the entry line,
   `<tool name>: <first sentence>`. Vectors live in `mcp.search_embeddings`
   (migration 20260928120000), one row per workspace, target key, and
   content hash, under row-level security. A change of provider, url, or
   model changes the target key, so every entry embeds again.
4. **Publish embeds the entries that changed.** After `project()` writes the
   tool registry, `warmSearch` embeds each entry the table does not hold
   under the current key. It sends up to 128 lines per request and one
   request at a time. Publish waits up to 15 seconds (`WARM_WAIT_MS`). The
   warm then keeps going, and it logs its result when it ends.
5. **Publish deletes the rows no search reads.** Once the warm finishes, it
   deletes every row under another target key and every row whose hash no
   current entry carries. A workspace set to `keyword`, or one with no
   search-mode server, has all its rows deleted.
6. **Search falls back to keyword ranking.** A missing key, an unreadable
   credential, an endpoint that fails or times out, and a malformed answer
   each throw `SearchIndexError`. Search logs the error's name and code, then
   ranks by keyword. Search waits 5 seconds for vectors, and each request
   has a 10-second deadline. `tools/list` never reads the index.
7. **No log carries a key, an endpoint url, or a response body.** Logs carry
   the error's name, its code, counts, and the workspace id.

## Consequences

- **Embedding spend on the `oxagen` provider is platform cost.** Tokens go to
  Oxagen's Voyage AI account, and no rate card entry charges the workspace.
  An entry is one line and embeds once per target key and content hash. A
  publish sends only new lines, and a search sends one query line, which
  the process caches. If this spend grows, a later change bills it the way
  `@oxagen/ai` bills other embeddings.
- **The `oxagen` provider's spend stays visible in `token_usage`.** Each
  request is admitted to the usage outbox before it is sent, as `@oxagen/ai`
  does for its own embeddings. An answered request finalizes the row with
  the input tokens from the response's `usage.total_tokens`, the duration,
  the surface `mcp`, the prompt hash, and the provider cost from the rate
  card, even when the vectors are then refused. A request the endpoint
  refuses or never answers voids it. The row charges no credits.
  `searchUsageMeter` in `packages/handlers/src/mcp-studio/search-usage.ts`
  writes it. A failed admission is logged with an alert and never fails a
  search or a publish. (Amended by #2972: the row was first written after
  the response, so a process that died mid-request left no record.)
- **A `custom` provider bills the workspace's own account.** Oxagen charges
  nothing for those tokens and writes no `token_usage` row for them.
- **These calls are the one exception to the `@oxagen/ai` rule.**
  `AGENTS.md` and `CLAUDE.md` name it. Every other model call still goes
  through `@oxagen/ai`.
- **Publish can take up to 15 seconds longer** when a search-mode server's
  entries change.
- **A search can embed an entry itself.** The warm deletes old rows before
  the new version goes live. A search on the old version in that gap finds
  no vector for a changed entry, embeds it, and stores it. The next publish
  deletes that row. A publish that returns before its warm ends leaves the
  same gap, and search closes it the same way.
- **Publish embeds every entry, including tools a policy hides.** Policy
  decides visibility for each run, so publish cannot know which entries a
  run will see. Search ranks only the entries the run's policy leaves
  visible, so a hidden tool never appears in a result.
- **Studio's Try it has no served path yet.** It runs no search, and this
  decision meters nothing for it. The served path meters every `search`,
  `describe`, and `call`, including a call that policy denies or parks.
- **Moving the `oxagen` provider to another model** changes
  `OXAGEN_EMBEDDING_MODEL` in `packages/mcp-studio/src/search/settings.ts`.
  The target key changes with it, so the next publish embeds every entry
  again and deletes the old rows.
