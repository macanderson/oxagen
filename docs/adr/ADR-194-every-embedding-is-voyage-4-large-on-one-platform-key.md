# ADR-194: Every embedding is voyage-4-large on one platform key

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** ai, knowledge
- **Amends:** ADR-053 §2 (an organisation's own gateway key served its
  embeddings, unbilled).
- **Related:** issue #4148 (production embeddings refused), issue #2974
  (ingestion drops records when the embedding key is rejected).

## Context

Oxagen embedded every text with `openai/text-embedding-3-small` through the
Vercel AI Gateway. The gateway team that production's key belongs to had no
paid credits, and from about 2026-09-23 the gateway refused every embedding.
Ingestion stored GitHub records in Neo4j without vectors, semantic recall over
them returned nothing, and `agent/memory/remember` answered an unhandled 500
carrying the gateway's upgrade text (#4148).

## Decision

Mac decided on 2026-09-26:

1. **Embeddings leave the gateway.** Every embedding goes to Voyage AI's REST
   API (`https://api.voyageai.com/v1/embeddings`). The gateway still serves
   language models.
2. **One platform key serves every organisation.** The key is
   `VOYAGE_API_KEY`, held in Parameter Store at
   `/oxagen/production/VOYAGE_API_KEY`. An organisation's own key never serves
   an embedding, so every embedding is metered and billed.
3. **The model is `voyage-4-large` at 1,024 dimensions.** Mac first asked for
   "voyage-large-3", a name Voyage refuses with a 400. The nearest real model,
   `voyage-3-large`, is on Voyage's older-models list, and Mac then chose
   `voyage-4-large`, Voyage's current large model. `EMBEDDING_MODEL` and
   `EMBEDDING_DIMENSIONS` in `packages/ai/src/embed.ts` pin both.

What follows from the decision:

- **Every vector index is 1,024 dimensions.** The five vector indexes in
  `packages/ontology/src/schema.cypher` change from 1,536. `CREATE VECTOR
  INDEX ... IF NOT EXISTS` never resizes an index, so the migrator
  (`resizeEmbeddingIndexes` in `packages/ontology/src/migrate.ts`) drops an
  embedding index of another size before the schema runs, in the pooled
  database and in every organisation database.
- **Vectors of the old size are cleared.** Neo4j leaves a mis-sized vector out
  of its index without an error, so a 1,536-dimension vector would stay on its
  node, never be found, and never be selected by `n.embedding IS NULL`. The
  migrator clears those vectors and their `embeddingModel` in batches of
  1,000, and the backfill job embeds them again.
- **Callers say how the text is used.** `inputType` is `document` for text
  Oxagen stores and `query` for text it searches with. Voyage embeds the two
  differently.
- **A failure is typed.** `EmbeddingUnavailableError` (code
  `embedding_unavailable`) covers a missing key, a refused key, and Voyage
  staying down through the SDK's retries. The API answers it with 503 and logs
  Voyage's status and message.

## Consequences

- Voyage bills `voyage-4-large` at $0.12 per million tokens and does not
  charge the account's first 200 million (2026-09-26). The rate card carries
  $0.12 for every token, so Oxagen's charge follows Voyage's list price.
- An organisation with a gateway key used to embed on its own key at no
  charge. It is now charged for embeddings like every other organisation.
- Until the backfill finishes, recall and similarity dedup miss every node
  whose vector was cleared. Ingestion writes such a record as its own
  principal (`similarityDeferred`) rather than failing.
- Moving to another model changes `EMBEDDING_MODEL` and the rate card entry.
  If it returns 1,024 dimensions the index size stays the same, but every
  stored vector must still be embedded again, because vectors from two models
  do not compare.
- Staging reads `/oxagen/staging` and has no Voyage key. The key is required
  in production only, so a staging build warns, and embeddings there answer
  503 until a key is set.
- The Parameter Store entries `OXAGEN_EMBEDDING_MODEL` and
  `OXAGEN_EMBEDDING_DIMENSIONS` are read by nothing, before or after this
  change.
