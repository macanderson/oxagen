import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { createIngestionCryptoAdapter, decrypt } from "@oxagen/crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { embedText } from "@oxagen/ai";
import { parseSourceFile } from "@oxagen/ingestion/parsers";
import type { ParsedSymbol } from "@oxagen/ingestion/parsers";
import { chunkText } from "@oxagen/ingestion/embed";
import { logger } from "../logger";

// Skip files larger than 1000 KB — too expensive to parse + embed.
const MAX_CONTENT_BYTES = 1000 * 1024;
// Batch size for symbol upsert to keep Neo4j sessions bounded.
const SYMBOL_BATCH_SIZE = 20;
// Per-chunk upsert batch size (one embed call per chunk).
const CHUNK_BATCH_SIZE = 10;

// Shared embed telemetry. executionStepId MUST be a UUID or null — a synthesized
// string breaks the ClickHouse UUID insert + Postgres uuid credit charge.
const EMBED_TELEMETRY = (orgId: string, workspaceId: string) => ({
  telemetry: {
    orgId,
    workspaceId,
    surface: "ingestion" as const,
    executionStepId: null,
  },
});

/**
 * GitHub parse-file Inngest function.
 *
 * Triggered by "ingestion/github.parse-file". Fetches the raw file blob,
 * parses it via tree-sitter, upserts SourceFile + SourceSymbol nodes in Neo4j,
 * embeds the file text, and optionally fires a feature-inference event.
 *
 * Concurrency is limited to 20 parallel parses per org (fan-out stage).
 */
export const [ingestionGithubParseFile] = createFunction(
  {
    id: "ingestion-github-parse-file",
    retries: 3,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "ingestion/github.parse-file" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, owner, repo, sha, path } =
      event.data as {
        connectionId: string;
        orgId: string;
        workspaceId: string;
        owner: string;
        repo: string;
        sha: string;
        path: string;
      };

    // ── Step 1: Fetch access token ─────────────────────────────────────────────
    const accessToken = await step.run("fetch-token", async () => {
      const rows = await withSystemDb(async (tx) => {
        const result = await tx.execute(sql`
          SELECT oa.access_token_enc
          FROM   ingestion.oauth_accounts oa
          JOIN   ingestion.source_connections sc
                 ON sc.oauth_account_id = oa.id
          WHERE  sc.id     = ${connectionId}::uuid
          AND    sc.org_id = ${orgId}::uuid
          LIMIT  1
        `);
        return Array.from(result) as Array<{
          access_token_enc: { keyId: string; ciphertext: string } | null;
        }>;
      });

      const row = rows[0];
      if (!row?.access_token_enc) {
        throw new Error(
          `ingestion-github-parse-file: no oauth token for connectionId=${connectionId}`,
        );
      }

      const cryptoAdapter = createIngestionCryptoAdapter();
      const cipherBuf = Buffer.from(row.access_token_enc.ciphertext, "base64");
      const decrypted: unknown = await decrypt(cipherBuf, cryptoAdapter.keyId, {
        adapter: cryptoAdapter.adapter,
      });
      return Buffer.isBuffer(decrypted)
        ? decrypted.toString("utf8")
        : String(decrypted);
    });

    // ── Step 2: Fetch raw file content ────────────────────────────────────────
    const content = await step.run("fetch-content", async () => {
      const url = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3.raw",
          "User-Agent": "oxagen-ingestion/1.0",
        },
      });

      if (!response.ok) {
        throw new Error(
          `ingestion-github-parse-file: GitHub blob API returned ${response.status} for ${path}`,
        );
      }

      // Check Content-Length before reading body.
      const contentLength = Number(
        response.headers.get("content-length") ?? "0",
      );
      if (contentLength > MAX_CONTENT_BYTES) {
        logger.info(
          { path, connectionId, orgId, contentLength },
          "ingestion-github-parse-file: file too large, skipping",
        );
        return null;
      }

      const text = await response.text();
      if (text.length > MAX_CONTENT_BYTES) {
        logger.info(
          { path, connectionId, orgId, size: text.length },
          "ingestion-github-parse-file: file too large, skipping",
        );
        return null;
      }

      return text;
    });

    // Skip oversized or empty files.
    if (content === null) {
      return { skipped: true, reason: "file_too_large", path };
    }

    // ── Step 3: Parse the source file ─────────────────────────────────────────
    const parseResult = await step.run("parse-source-file", () =>
      parseSourceFile(path, content),
    );

    logger.debug(
      {
        path,
        language: parseResult.language,
        symbolCount: parseResult.symbols.length,
      },
      "ingestion-github-parse-file: parsed",
    );

    // ── Step 4: Upsert SourceFile node in Neo4j ───────────────────────────────
    const naturalKey = `github:${connectionId}:${owner}/${repo}:${path}`;

    const fileId = await step.run("upsert-source-file", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          const result = await session.run(
            // Carries the universal :GraphNode anchor + is_system + display fields
            // (label/displayName/sourceId/properties) so the file shows up in the
            // graph explorer and graph.search, which match the :GraphNode anchor
            // scoped by orgId + workspaceId. The MERGE key stays on :SourceFile so
            // the CONTAINS/SOURCED_FROM/HAS_CHUNK traversals below keep matching it.
            `MERGE (f:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
             ON CREATE SET
               f.publicId    = randomUUID(),
               f.createdAt   = datetime()
             ON MATCH SET
               f.syncedAt   = datetime()
             SET
               f:GraphNode,
               f.is_system   = true,
               f.path        = $path,
               f.language    = $language,
               f.repo        = $repo,
               f.owner       = $owner,
               f.connectionId = $connectionId,
               f.sourceId    = $connectionId,
               f.workspaceId = $workspaceId,
               f.sha         = $sha,
               f.label       = 'SourceFile',
               f.displayName = $path,
               f.properties  = $properties,
               f.updatedAt   = datetime()
             RETURN f.publicId AS fileId`,
            {
              naturalKey,
              orgId,
              path,
              language: parseResult.language,
              repo,
              owner,
              connectionId,
              workspaceId,
              sha,
              properties: JSON.stringify({
                path,
                language: parseResult.language,
                repo,
                owner,
                sha,
              }),
            },
          );
          const record = result.records[0];
          if (!record)
            throw new Error(
              `upsert-source-file: no record returned for ${naturalKey}`,
            );
          return record.get("fileId") as string;
        } finally {
          await session.close();
        }
      }),
    );

    // ── Step 5: Upsert SourceSymbol nodes (only if symbols found) ─────────────
    if (parseResult.symbols.length > 0) {
      // Process symbols in batches to keep session time bounded.
      const symbolBatches: ParsedSymbol[][] = [];
      for (let i = 0; i < parseResult.symbols.length; i += SYMBOL_BATCH_SIZE) {
        symbolBatches.push(parseResult.symbols.slice(i, i + SYMBOL_BATCH_SIZE));
      }

      for (let batchIdx = 0; batchIdx < symbolBatches.length; batchIdx++) {
        const batch = symbolBatches[batchIdx]!;
        await step.run(`upsert-symbols-batch-${batchIdx}`, () =>
          runInTenantScope({ orgId, workspaceId }, async () => {
            const session = scopedSession();
            try {
              for (const symbol of batch) {
                const symbolNaturalKey = `github:${connectionId}:${owner}/${repo}:${path}:${symbol.kind}:${symbol.name}`;
                await session.run(
                  // Same anchor pattern as SourceFile: MERGE on :SourceSymbol
                  // (keeps the CONTAINS edge match below), then SET adds the
                  // universal :GraphNode anchor + is_system + display fields so
                  // symbols are visible/traversable in the graph explorer
                  // (label = symbol kind, displayName = symbol name).
                  `MERGE (s:SourceSymbol {naturalKey: $naturalKey, orgId: $orgId})
                    ON CREATE SET
                      s.publicId    = randomUUID(),
                      s.createdAt   = datetime()
                    ON MATCH SET
                      s.syncedAt   = datetime()
                    SET
                      s:GraphNode,
                      s.is_system   = true,
                      s.name        = $name,
                      s.kind        = $kind,
                      s.label       = $kind,
                      s.displayName = $name,
                      s.startLine   = $startLine,
                      s.endLine     = $endLine,
                      s.fileNaturalKey = $fileNaturalKey,
                      s.connectionId = $connectionId,
                      s.sourceId    = $connectionId,
                      s.workspaceId = $workspaceId,
                      s.properties  = $properties,
                      s.updatedAt   = datetime()
                    WITH s
                    MATCH (f:SourceFile {naturalKey: $fileNaturalKey, orgId: $orgId})
                    MERGE (f)-[cont:CONTAINS]->(s)
                    SET cont.is_system = true`,
                  {
                    naturalKey: symbolNaturalKey,
                    orgId,
                    name: symbol.name,
                    kind: symbol.kind,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    fileNaturalKey: naturalKey,
                    connectionId,
                    workspaceId,
                    properties: JSON.stringify({
                      kind: symbol.kind,
                      name: symbol.name,
                      startLine: symbol.startLine,
                      endLine: symbol.endLine,
                      path,
                    }),
                  },
                );
              }

              // After all symbols: MERGE SourceFile → SourceConnection edge.
              await session.run(
                `MATCH (f:SourceFile {naturalKey: $fileNaturalKey, orgId: $orgId})
                  MERGE (sc:SourceConnection {id: $connectionId, orgId: $orgId})
                  MERGE (f)-[srcd:SOURCED_FROM]->(sc)
                  SET srcd.is_system = true`,
                { fileNaturalKey: naturalKey, orgId, connectionId },
              );
            } finally {
              await session.close();
            }
          }),
        );
      }
    }

    // ── Step 6: Chunk the full body and upsert embedded :SourceChunk nodes ────
    // This is what makes the ENTIRE file content searchable by similarity, not
    // just the named symbols. Each chunk is its own :GraphNode with an embedding.
    const { chunks, truncated: chunksTruncated } = chunkText(content);
    if (chunksTruncated) {
      logger.info(
        { path, orgId, chunkCount: chunks.length },
        "ingestion-github-parse-file: file exceeded chunk cap — tail not chunked",
      );
    }
    if (chunks.length > 0) {
      const chunkBatches: (typeof chunks)[] = [];
      for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
        chunkBatches.push(chunks.slice(i, i + CHUNK_BATCH_SIZE));
      }
      for (let batchIdx = 0; batchIdx < chunkBatches.length; batchIdx++) {
        const batch = chunkBatches[batchIdx]!;
        await step.run(`upsert-chunks-batch-${batchIdx}`, async () => {
          const embeddings = await Promise.all(
            batch.map(async (chunk) => {
              try {
                return await embedText(chunk.text, EMBED_TELEMETRY(orgId, workspaceId));
              } catch (err) {
                logger.warn({ err, path, chunk: chunk.index }, "parse-file: chunk embed failed");
                return null;
              }
            }),
          );
          return runInTenantScope({ orgId, workspaceId }, async () => {
            const session = scopedSession();
            try {
              for (let i = 0; i < batch.length; i++) {
                const chunk = batch[i]!;
                const embedding = embeddings[i];
                const chunkNaturalKey = `${naturalKey}:chunk:${chunk.index}`;
                await session.run(
                  `MERGE (c:SourceChunk {naturalKey: $naturalKey, orgId: $orgId})
                   ON CREATE SET
                     c.publicId  = randomUUID(),
                     c.createdAt = datetime()
                   ON MATCH SET
                     c.syncedAt = datetime()
                   SET
                     c:GraphNode,
                     c.is_system   = true,
                     c.label       = 'SourceChunk',
                     c.displayName = $displayName,
                     c.chunkIndex  = $chunkIndex,
                     c.startLine   = $startLine,
                     c.endLine     = $endLine,
                     c.fileNaturalKey = $fileNaturalKey,
                     c.connectionId = $connectionId,
                     c.sourceId    = $connectionId,
                     c.workspaceId = $workspaceId,
                     c.content     = $content,
                     c.properties  = $properties,
                     c.embedding   = coalesce($embedding, c.embedding),
                     c.embeddingUpdatedAt = CASE WHEN $embedding IS NULL THEN c.embeddingUpdatedAt ELSE datetime() END,
                     c.updatedAt   = datetime()
                   WITH c
                   MATCH (f:SourceFile {naturalKey: $fileNaturalKey, orgId: $orgId})
                   MERGE (f)-[hc:HAS_CHUNK]->(c)
                   SET hc.is_system = true`,
                  {
                    naturalKey: chunkNaturalKey,
                    orgId,
                    displayName: `${path} [${chunk.index}]`,
                    chunkIndex: chunk.index,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    fileNaturalKey: naturalKey,
                    connectionId,
                    workspaceId,
                    content: chunk.text,
                    embedding: embedding ?? null,
                    properties: JSON.stringify({
                      path,
                      chunkIndex: chunk.index,
                      startLine: chunk.startLine,
                      endLine: chunk.endLine,
                      content: chunk.text,
                    }),
                  },
                );
              }
            } finally {
              await session.close();
            }
          });
        });
      }
    }

    // ── Step 7: Embed file ─────────────────────────────────────────────────────
    const embedInput =
      `${path} ${parseResult.language} ${parseResult.symbols.map((s) => s.name).join(" ")}`.trim();

    const embedding = await step.run("embed-file", () =>
      embedText(embedInput, {
        telemetry: {
          orgId,
          workspaceId,
          surface: "ingestion",
          // No execution step for repo-file embeds. Must be a UUID or null — a
          // synthesized `embed-file:<naturalKey>` string broke the ClickHouse
          // UUID insert (flooded POST /api/inngest with code-27 parse errors)
          // and the Postgres uuid credit charge. See @oxagen/telemetry NIL_UUID.
          executionStepId: null,
        },
      }),
    );

    // Store embedding on the SourceFile node.
    await step.run("store-file-embedding", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          await session.run(
            `MATCH (f:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
              SET f.embedding = $embedding, f.embeddingUpdatedAt = datetime()`,
            { naturalKey, orgId, embedding },
          );
        } finally {
          await session.close();
        }
      }),
    );

    // ── Step 7: Fire feature inference event (if applicable) ──────────────────
    if (parseResult.language !== "unknown" && parseResult.symbols.length > 0) {
      await step.sendEvent("infer-features", {
        name: "ingestion/github.infer-features" as const,
        data: {
          fileNaturalKey: naturalKey,
          symbols: parseResult.symbols,
          orgId,
          workspaceId,
          connectionId,
        },
      });
    }

    logger.info(
      {
        path,
        language: parseResult.language,
        symbolCount: parseResult.symbols.length,
        orgId,
      },
      "ingestion-github-parse-file: completed",
    );

    return {
      path,
      fileId,
      language: parseResult.language,
      symbolCount: parseResult.symbols.length,
    };
  },
);
