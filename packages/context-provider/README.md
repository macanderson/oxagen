# @oxagen/context-provider

The Context Exchange Provider: one oxagen workspace's memory, served as
Context Graph Protocol frames.

A host asks for context relevant to a goal. This answers with frames drawn
from that workspace's engram records — budgeted, scored, and carrying the
provenance that says where each one came from.

## Running it

It speaks the protocol's line-oriented JSON over stdio, which is the shape the
reference host and the conformance suite drive.

```bash
OXAGEN_CONTEXT_ORG=acme \
OXAGEN_CONTEXT_WORKSPACE=platform \
ENGRAM_DUCKDB_PATH=/path/to/engram.duckdb \
pnpm --filter @oxagen/context-provider serve
```

Both `OXAGEN_CONTEXT_ORG` and `OXAGEN_CONTEXT_WORKSPACE` are required and have
no default. The protocol carries no tenant, so a process that could reach two
workspaces would have no way to be told which one a query meant; one process
serves one workspace, and which one is a deployment decision. Without
`ENGRAM_DUCKDB_PATH` the store is in-memory and every query answers with
nothing — the right answer for a misconfigured process, rather than someone
else's memory.

To drive it by hand, write one envelope per line:

```bash
echo '{"type":"handshake","protocol_version":"contextgraph/1.0-draft"}' \
  | OXAGEN_CONTEXT_ORG=acme OXAGEN_CONTEXT_WORKSPACE=platform \
    pnpm --filter @oxagen/context-provider serve
```

## What it declares at handshake

| Capability | Value | Why |
|---|---|---|
| `query.kinds` | `episode`, `fact`, `memory`, `graph` | the kinds engram records map onto |
| `correlation` | `true` | the SDK's runtime echoes a query's `id` |
| `verify` | `true` | records are content-addressed, so a frame's validity is answerable |
| `graph` | `false` | `entity`/`edge` records are served as `graph` frames, but nothing traverses |
| `embeddings_fingerprint` | `null` | records may carry a vector; this does not rank with it |
| `resolve` | `false` | every frame is `full`, so there is no reference to resolve |
| `data_flow` | reads, no writes, no egress | a query never leaves the process |

CGP's `snippet`, `symbol` and `doc` kinds are not served — engram holds no
file ranges or documents — and are left out of the declaration rather than
answered empty.

## How a record becomes a frame

| engram | CGP frame | |
|---|---|---|
| `episodic` | `episode` | the same concept under two names |
| `semantic` | `fact` | a claim about the world, not about a moment |
| `procedural` | `memory` | learned how-to; CGP has no procedural kind |
| `entity` | `graph` | a node, meaningful through its edges |
| `edge` | `graph` | an edge, likewise |

Two hashes travel with each frame and they are not the same hash.
`canonical_content_hash` is the record's own id, which engram computes over the
source. `content_digest` is taken over the bytes the frame actually carries.
A host verifying a frame checks the second; the record it came from is
identified by the first.

`token_cost` is the protocol's §B3 accounting unit —
`ceil(utf8_byte_length(content) / 4)` — computed by the SDK rather than
restated here, and asserted against the SDK in `frames.test.ts`.

## Ranking and budget

With `query_text`, records are scored by engram's lexical search: the fraction
of query terms a record matches. Without it there is nothing to be relevant to,
so the ranking falls back to the record's salience, which is the store's own
judgement of importance and is already in `[0, 1]`.

`max_frames` and `max_tokens` are both hard. Frames are considered best-first
and one that does not fit is skipped while the walk continues, so a single
large frame near the top cannot discard every smaller frame beneath it. The
result is therefore not a prefix of the ranking, which is why
`dropped_estimate` is reported rather than left to be inferred.

## Layout

| File | |
|---|---|
| `src/provider.ts` | the `Provider` itself — `info`, `capabilities`, `query`, `verify` |
| `src/frames.ts` | one record rendered as one frame; pure |
| `src/budget.ts` | fitting frames into the host's budget; pure |
| `src/kinds.ts` | the kind mapping, read in both directions |
| `src/bin.ts` | the stdio entry point |
| `src/testing/` | an in-memory store and the fixture `stdio.test.ts` spawns |

## Tests

`stdio.test.ts` is the one that answers "is it reachable": it starts a real
process, writes envelopes to its stdin and reads them off its stdout, covering
the handshake, the correlation echo, verify, and staying alive on a malformed
line. The rest call the provider as a function.

```bash
pnpm --filter @oxagen/context-provider test:unit
```

## Conformance

Checked against the upstream suite in `macanderson/context-graph-protocol`,
which is the normative one — not a local re-implementation of it:

```bash
# in context-graph-protocol
cargo build -p contextgraph-conformance --bin contextgraph-inspect
./target/debug/contextgraph-inspect stdio -- /path/to/launcher.sh
```

The inspector spawns the provider without the parent's environment, so the
launcher is a two-line script that exports `OXAGEN_CONTEXT_ORG`,
`OXAGEN_CONTEXT_WORKSPACE` and `ENGRAM_DUCKDB_PATH` and `exec`s the binary —
the job a real host does when it starts a provider.

Last run: **CONFORMANT — 10 passed, 3 skipped**. The three skips are checks
that do not bind a provider declaring no `graph`, no `embeddings_fingerprint`
and no file provenance.

**Seed the workspace with records matching the probe first.** The suite queries
`query_text: "conformance probe"`, and against a store holding nothing that
matches, `frame-validity`, `budget-honesty` and `verify-honesty` all pass over
an empty result — a green run that has checked nothing. Seeding two matching
records is what turned the first CONFORMANT into a real failure:
`verify-honesty` caught this provider declining to vouch for frames it had just
served, because it compared `FrameId.provider_id` against its own name.
`provider_id` is the HOST's name for a provider — the reference host labels one
under test `provider-under-test` — so that comparison was wrong, and `verify`
now answers on `frame_id` alone.

## Known deviations

Recorded here rather than left implicit, per #1084's acceptance.

- **`docs/specs/adaptive-context/context-frame-spec.md` is not the contract
  this implements.** It is a superseded draft; the normative source is the
  upstream `SPEC.md` in `context-graph-protocol`, which is what the SDK's types
  mirror. Where the two disagree, this follows the SDK.
- **No embedding-based ranking.** Records can carry a quantized vector and this
  does not use it, which is why `embeddings_fingerprint` is `null` rather than
  a name a host might compare its own vectors against.
- **A host must not close the provider's stdin before it has read the
  replies.** `runStdioProvider` exits on EOF, and it does so without waiting
  for a reply already in flight — so
  `printf '<handshake>\n<query>\n' | oxagen-context-provider` prints the
  handshake and never the frames, because the query's store read had not
  finished when the pipe closed. Holding stdin open until the reply arrives is
  enough, and is what a real host does. Observed against SDK 0.1.0; worth
  upstreaming as a shutdown-ordering fix rather than worked around here, since
  nothing on this side can hold the process open.
- **Seeding and serving must be separate processes.** DuckDB opens a database
  as a single writer, and a process that has held it keeps the lock. This is a
  property of the store, not of the protocol, and
  `src/testing/serve-real-workspace.ts` is split into three processes because
  of it.
- **`compact` and `reference` representations are not produced.** Every frame
  is `full`, so a host cannot ask for a cheaper form of a large record; it gets
  the record or, past the budget, nothing.
