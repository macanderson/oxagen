import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { resolveIngestionCryptoAdapterForKeyId, decrypt } from "@oxagen/crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import {
  toNaturalKey,
  codeScopeNaturalKey,
} from "@oxagen/ontology/natural-key";
import { parseSourceFile } from "@oxagen/ingestion/parsers";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Transient canonical-snapshot projector (workspace-graph-boundary spec)
// ---------------------------------------------------------------------------
//
// This function is NO LONGER a source-index builder. It projects one file of a
// PINNED canonical snapshot into the governed workspace graph as commit-
// addressed topology ONLY:
//   (:SourceFile)-[:SOURCED_FROM]->(:SourceConnection)
//   (:SourceFile)-[:IN_SCOPE]->(:CodeScope)
//   (:CodeScope)-[:DEPENDS_ON {count}]->(:CodeScope)   (cross-scope imports)
//
// The old model — :SourceSymbol / :SourceChunk / CALLS / file-level IMPORTS /
// plaintext chunks / source embeddings — is GONE from the workspace graph (spec
// §"What to delete or replace", four-store law). Exact working-code detail
// lives only in Stella's local graph. The deterministic parser is kept purely
// as a TRANSIENT input: language detection + import extraction feed the
// scope-level dependency aggregation, and the symbol list still rides the
// (bounded, inferred, non-authoritative) feature-inference event.
//
// Every fan-out event emits EXACTLY ONE `ingestion/github.generation-file-done`
// — success (skipped:false) or any skip path (skipped:true) — via step.sendEvent
// (Inngest memoizes a completed step across retries, so a retried invocation
// re-emits zero extra events). d3's atomic counter activates the generation when
// processed + skipped reaches files_total, so a missed OR doubled emission would
// wedge/early-activate it.

// Skip files larger than 1000 KB — too expensive to fetch + project.
const MAX_CONTENT_BYTES = 1000 * 1024;

/**
 * Resolve a RELATIVE import specifier (starts with ".") to a normalised
 * intra-repo path, folding out "." / ".." segments relative to the importing
 * file's directory. Returns null when it escapes the repo root. Extension is
 * irrelevant here — we only need the path for longest-prefix scope matching, so
 * a trailing extension (if any) is left as-is and harmlessly ignored by the
 * boundary-aware prefix match.
 */
function resolveRelativeImportPath(
  filePath: string,
  specifier: string,
): string | null {
  const dirParts = filePath.split("/").slice(0, -1);
  const specParts = specifier.split("/");
  const parts: string[] = [];
  for (const seg of [...dirParts, ...specParts]) {
    if (seg === "..") {
      if (parts.length === 0) return null; // escaped repo root — unresolved
      parts.pop();
    } else if (seg !== "." && seg !== "") {
      parts.push(seg);
    }
  }
  const resolved = parts.join("/");
  return resolved || null;
}

/**
 * Longest-prefix-match a repo path to a code-scope key on SEGMENT boundaries
 * (so `packages/api` matches `packages/api/src/x` but never `packages/api-v2`).
 * Returns the longest matching scopeKey, or null when the path is outside every
 * known scope.
 */
function scopeForPath(path: string, scopeKeys: string[]): string | null {
  let best: string | null = null;
  for (const key of scopeKeys) {
    if (path === key || path.startsWith(`${key}/`)) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best;
}

/**
 * GitHub parse-file Inngest function — canonical-snapshot projector.
 *
 * Triggered by "ingestion/github.parse-file" at a pinned commit/tree SHA.
 * Concurrency limited to 5 parallel parses per org (fan-out stage).
 */
export const [ingestionGithubParseFile] = createFunction(
  {
    id: "ingestion-github-parse-file",
    retries: 3,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "ingestion/github.parse-file" },
  async ({ event, step }) => {
    const {
      connectionId,
      orgId,
      workspaceId,
      owner,
      repo,
      sha,
      path,
      generationId,
      commitSha,
      treeSha,
      scopeKey,
    } = event.data as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      owner: string;
      repo: string;
      sha: string;
      path: string;
      repositoryId: string;
      generationId: string;
      commitSha: string;
      treeSha: string;
      scopeKey: string;
      codeScopeId: string;
    };

    // Emit the generation-completion signal exactly once. Each call is its own
    // Inngest step (unique id per outcome) so it is durable + memoized across
    // retries — a retried invocation replays the already-completed send without
    // re-emitting.
    const emitDone = (stepId: string, skipped: boolean) =>
      step.sendEvent(stepId, {
        name: "ingestion/github.generation-file-done" as const,
        data: { orgId, workspaceId, generationId, skipped },
      });

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

      // Route by the envelope's stored keyId, not the current provider env var,
      // so tokens wrapped under a previous INGESTION_CRYPTO_PROVIDER still decrypt.
      const cryptoAdapter = resolveIngestionCryptoAdapterForKeyId(
        row.access_token_enc.keyId,
      );
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

    // ── Skip path: oversized / empty ──────────────────────────────────────────
    if (content === null) {
      await emitDone("done-too-large", true);
      return { skipped: true, reason: "file_too_large", path };
    }

    // ── Skip path: binary ─────────────────────────────────────────────────────
    // A NUL byte is the standard cheap binary sniff. Binary blobs are never
    // projected as SourceFiles (they carry no scope-level import structure).
    if (content.includes("\u0000")) {
      logger.info(
        { path, connectionId, orgId },
        "ingestion-github-parse-file: binary content, skipping",
      );
      await emitDone("done-binary", true);
      return { skipped: true, reason: "binary", path };
    }

    // ── Step 3: Parse (transient) — language + imports + symbols ───────────────
    // A parser throw must NOT propagate: an uncaught throw retries forever and
    // never emits generation-file-done, wedging the generation's activation
    // gate. Swallow it as a skip instead.
    // Declared without `| null` — the catch returns, so past this point
    // parseResult is definitely assigned and non-null.
    let parseResult: Awaited<ReturnType<typeof parseSourceFile>>;
    try {
      parseResult = await step.run("parse-source-file", () =>
        parseSourceFile(path, content),
      );
    } catch (err) {
      logger.warn(
        { err, path, connectionId, orgId },
        "ingestion-github-parse-file: parse failed, skipping",
      );
      await emitDone("done-parse-failed", true);
      return { skipped: true, reason: "parse_failed", path };
    }

    logger.debug(
      {
        path,
        language: parseResult.language,
        symbolCount: parseResult.symbols.length,
      },
      "ingestion-github-parse-file: parsed",
    );

    // ── Step 4: MERGE the slim SourceFile + SOURCED_FROM + IN_SCOPE ────────────
    // Commit-addressed identity (github:{owner}/{repo}:{path}) — no connectionId,
    // unified with file-lock + run lineage (spec finding 4). No embeddings, no
    // symbol/chunk detail. The CodeScope is MERGEd minimally here (ON CREATE
    // only) so we never clobber the richer props projectSnapshotToGraph writes.
    const naturalKey = toNaturalKey(path, owner, repo);
    const scopeNaturalKey = codeScopeNaturalKey(owner, repo, scopeKey);

    const fileId = await step.run("project-source-file", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          const result = await session.run(
            `MERGE (f:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
             ON CREATE SET
               f.publicId  = randomUUID(),
               f.createdAt = datetime()
             ON MATCH SET
               f.syncedAt = datetime()
             SET
               f:GraphNode,
               f.is_system    = true,
               f.path         = $path,
               f.language     = $language,
               f.commitSha    = $commitSha,
               f.treeSha      = $treeSha,
               f.generationId = $generationId,
               f.scopeKey     = $scopeKey,
               f.repo         = $repo,
               f.owner        = $owner,
               f.sourceId     = $connectionId,
               f.workspaceId  = $workspaceId,
               f.label        = 'SourceFile',
               f.displayName  = $path,
               f.properties   = $properties,
               f.updatedAt    = datetime()
             WITH f
             MERGE (sc:SourceConnection {id: $connectionId, orgId: $orgId})
             MERGE (f)-[srcd:SOURCED_FROM]->(sc)
             SET srcd.is_system = true
             WITH f
             MERGE (scope:CodeScope {naturalKey: $scopeNaturalKey, orgId: $orgId})
             ON CREATE SET
               scope.publicId    = randomUUID(),
               scope.createdAt   = datetime(),
               scope:GraphNode,
               scope.is_system   = true,
               scope.label       = 'CodeScope',
               scope.scopeKey    = $scopeKey,
               scope.displayName = $scopeKey,
               scope.workspaceId = $workspaceId
             MERGE (f)-[insc:IN_SCOPE]->(scope)
             SET insc.is_system = true
             RETURN f.publicId AS fileId`,
            {
              naturalKey,
              orgId,
              path,
              language: parseResult.language,
              commitSha,
              treeSha,
              generationId,
              scopeKey,
              repo,
              owner,
              connectionId,
              workspaceId,
              scopeNaturalKey,
              properties: JSON.stringify({
                path,
                language: parseResult.language,
                commitSha,
                treeSha,
                generationId,
                scopeKey,
              }),
            },
          );
          const record = result.records[0];
          if (!record)
            throw new Error(
              `project-source-file: no record returned for ${naturalKey}`,
            );
          return record.get("fileId") as string;
        } finally {
          await session.close();
        }
      }),
    );

    // ── Step 5: Scope-level dependency aggregation (cross-scope imports) ───────
    // Resolve each RELATIVE import to a repo path, longest-prefix-match it to a
    // scopeKey from the generation's code_scopes, and MERGE a CodeScope
    // DEPENDS_ON edge for every scope other than this file's own. External
    // (bare npm) specifiers are ignored. Target scopes are deduped per file so a
    // file contributes at most +1 to each cross-scope edge count.
    const relativeImports = (parseResult.imports ?? []).filter(
      ({ specifier }) => specifier.startsWith("."),
    );

    if (relativeImports.length > 0) {
      // The full scope-key set for this generation, read the same way sibling
      // ingestion functions read Postgres (withSystemDb + explicit org filter).
      const scopeKeys = await step.run("load-scope-keys", async () => {
        const rows = await withSystemDb(async (tx) => {
          const result = await tx.execute(sql`
            SELECT scope_key
            FROM   ingestion.code_scopes
            WHERE  generation_id = ${generationId}::uuid
            AND    org_id        = ${orgId}::uuid
          `);
          return Array.from(result) as Array<{ scope_key: string }>;
        });
        return rows.map((r) => r.scope_key);
      });

      const targetScopeKeys = new Set<string>();
      for (const { specifier } of relativeImports) {
        const resolved = resolveRelativeImportPath(path, specifier);
        if (!resolved) continue;
        const targetScope = scopeForPath(resolved, scopeKeys);
        if (targetScope && targetScope !== scopeKey) {
          targetScopeKeys.add(targetScope);
        }
      }

      if (targetScopeKeys.size > 0) {
        const targets = [...targetScopeKeys].map((key) => ({
          naturalKey: codeScopeNaturalKey(owner, repo, key),
          scopeKey: key,
        }));
        await step.run("aggregate-scope-dependencies", () =>
          runInTenantScope({ orgId, workspaceId }, async () => {
            const session = scopedSession();
            try {
              // count is incremented per (source-scope, target-scope, file)
              // observation. NOTE: it double-counts across re-projections of the
              // same generation (scope nodes are not generation-scoped) — a known
              // launch limitation; the authoritative dependency evidence lands
              // as {evidence_digest} when the evidence-ledger linkage ships.
              await session.run(
                `MATCH (from:CodeScope {naturalKey: $fromScopeKey, orgId: $orgId})
                 UNWIND $targets AS t
                 MERGE (to:CodeScope {naturalKey: t.naturalKey, orgId: $orgId})
                 ON CREATE SET
                   to.publicId    = randomUUID(),
                   to.createdAt   = datetime(),
                   to:GraphNode,
                   to.is_system   = true,
                   to.label       = 'CodeScope',
                   to.scopeKey    = t.scopeKey,
                   to.displayName = t.scopeKey,
                   to.workspaceId = $workspaceId
                 MERGE (from)-[dep:DEPENDS_ON]->(to)
                 ON CREATE SET
                   dep.is_system = true,
                   dep.count     = 1,
                   dep.createdAt = datetime()
                 ON MATCH SET
                   dep.count     = coalesce(dep.count, 0) + 1,
                   dep.updatedAt = datetime()`,
                { fromScopeKey: scopeNaturalKey, orgId, workspaceId, targets },
              );
            } finally {
              await session.close();
            }
          }),
        );
      }
    }

    // ── Step 6: Fire feature inference event ──────────────────────────────────
    // (bounded, inferred, non-authoritative). Default: one per-file event →
    // synchronous inference. With INGESTION_FEATURE_BATCH=1, emit the batched
    // event instead (half-price Message Batch). Payload is identical; only the
    // routing differs. The fileNaturalKey is now the canonical (connectionId-
    // less) key.
    if (parseResult.language !== "unknown" && parseResult.symbols.length > 0) {
      const batchMode = process.env.INGESTION_FEATURE_BATCH === "1";
      await step.sendEvent("infer-features", {
        name: (batchMode
          ? "ingestion/github.infer-features-batch"
          : "ingestion/github.infer-features") as
          | "ingestion/github.infer-features-batch"
          | "ingestion/github.infer-features",
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
        scopeKey,
        orgId,
      },
      "ingestion-github-parse-file: projected",
    );

    // ── Success: emit the completion signal exactly once ──────────────────────
    await emitDone("done-processed", false);

    return {
      path,
      fileId,
      language: parseResult.language,
      symbolCount: parseResult.symbols.length,
      skipped: false,
    };
  },
);
