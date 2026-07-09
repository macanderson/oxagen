import type { CapabilityHandler } from "@oxagen/oxagen";
import { codeMap } from "@oxagen/oxagen/contracts/code.map";
import { scopedSession } from "@oxagen/ontology/tenant";
import { oversampledLimit } from "@oxagen/ontology/ann";
import { runInTenantScope } from "@oxagen/tenancy";
import { embedText } from "@oxagen/ai";
import { logger } from "./logger";

// ── code.map handler ──────────────────────────────────────────────────────────
//
// Answers "give me everything related to <concept>" in one structured bundle.
//
// Traversal strategy (single tenant-scoped session):
//   1. Embed the query via embedText (same vector index as graph.search).
//   2. Pull top-k SourceFile nodes by vector similarity.
//   3. OPTIONAL MATCH CALLS edges between matched SourceSymbol nodes
//      (empty array when not yet ingested — degrades gracefully).
//   4. OPTIONAL MATCH (:Commit)-[:MODIFIED]->(:SourceFile) for recentChanges
//      (empty array when not yet ingested — degrades gracefully).
//   5. Filter by `domain` property when requested, but ONLY when the property
//      exists on the node (coalesce prevents mismatches on un-annotated nodes).

type FileRow = {
  nodeId: string;
  path: string;
  language: string;
  displayName: string;
  domain: string | null;
  score: number;
};

type SymbolRow = {
  nodeId: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
  docComment: string | null;
  domain: string | null;
  score: number;
};

type CallRow = {
  callerNodeId: string;
  calleeNodeId: string;
  callerName: string;
  calleeName: string;
};

type CommitRow = {
  commitSha: string;
  message: string;
  authorName: string;
  committedAt: string;
  modifiedFiles: string[];
};

// Integer-safe coerce. Neo4j returns Long for integer properties — normalise to JS number.
function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v !== null && v !== undefined && typeof (v as { toNumber?: unknown }).toNumber === "function") {
    return (v as { toNumber(): number }).toNumber();
  }
  return 0;
}

export const codeMapHandler: CapabilityHandler<typeof codeMap> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  const queryVector = await embedText(input.query, {
    telemetry: {
      orgId,
      workspaceId,
      surface: "app",
      executionStepId: null,
    },
  });

  const wantFiles = !input.kinds || input.kinds.includes("file");
  const wantSymbols = !input.kinds || input.kinds.includes("symbol");
  const wantCommits = !input.kinds || input.kinds.includes("commit");

  // Over-fetch files so the tenant + label + domain filters don't starve the
  // result set (capped so a large limit can't explode the index scan).
  const fileFetchLimit = oversampledLimit(input.limit);

  const domainClause = input.domain
    ? "AND (n.domain IS NULL OR coalesce(n.domain, '') = $domain)"
    : "";

  const fileRows: FileRow[] = [];
  const symbolRows: SymbolRow[] = [];
  const callRows: CallRow[] = [];
  const commitRows: CommitRow[] = [];

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // ── Step 1: Semantic file search ────────────────────────────────────────
      if (wantFiles || wantSymbols || wantCommits) {
        const fileResult = await session.run(
          `CALL db.index.vector.queryNodes('graph_node_embedding_index', $k, $queryVector)
           YIELD node AS n, score
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND 'SourceFile' IN labels(n)
             ${domainClause}
           RETURN n.publicId                              AS nodeId,
                  coalesce(n.path, n.publicId)           AS path,
                  coalesce(n.language, '')               AS language,
                  coalesce(n.displayName, n.path, n.publicId) AS displayName,
                  n.domain                               AS domain,
                  score
           ORDER BY score DESC LIMIT $limit`,
          {
            k: BigInt(fileFetchLimit),
            queryVector,
            orgId,
            workspaceId,
            domain: input.domain ?? null,
            limit: BigInt(input.limit),
          },
        );

        for (const rec of fileResult.records) {
          fileRows.push({
            nodeId: rec.get("nodeId") as string,
            path: rec.get("path") as string,
            language: rec.get("language") as string,
            displayName: rec.get("displayName") as string,
            domain: rec.get("domain") as string | null,
            score: rec.get("score") as number,
          });
        }
      }

      const fileNodeIds = fileRows.map((f) => f.nodeId);

      // ── Step 2: Gather symbols for matched files ─────────────────────────────
      if (wantSymbols && fileNodeIds.length > 0) {
        const symbolResult = await session.run(
          `MATCH (f:SourceFile {orgId: $orgId, workspaceId: $workspaceId})
             WHERE f.publicId IN $fileNodeIds
           MATCH (f)-[:CONTAINS]->(s:SourceSymbol)
           RETURN s.publicId                              AS nodeId,
                  coalesce(s.name, s.publicId)           AS name,
                  coalesce(s.kind, 'unknown')            AS kind,
                  coalesce(f.path, f.publicId)           AS path,
                  s.startLine                            AS startLine,
                  s.endLine                              AS endLine,
                  coalesce(s.signature, s.name, '')      AS signature,
                  s.docComment                           AS docComment,
                  s.domain                               AS domain,
                  1.0                                    AS score`,
          { orgId, workspaceId, fileNodeIds },
        );

        for (const rec of symbolResult.records) {
          symbolRows.push({
            nodeId: rec.get("nodeId") as string,
            name: rec.get("name") as string,
            kind: rec.get("kind") as string,
            path: rec.get("path") as string,
            startLine: toNumber(rec.get("startLine")),
            endLine: toNumber(rec.get("endLine")),
            signature: rec.get("signature") as string,
            docComment: rec.get("docComment") as string | null,
            domain: rec.get("domain") as string | null,
            score: rec.get("score") as number,
          });
        }

        // ── Step 3: CALLS edges between matched symbols ────────────────────────
        // OPTIONAL: absent when call-edge ingestion hasn't landed yet.
        const symbolNodeIds = symbolRows.map((s) => s.nodeId);
        if (symbolNodeIds.length > 0) {
          try {
            const callResult = await session.run(
              `MATCH (caller:SourceSymbol)-[:CALLS]->(callee:SourceSymbol)
               WHERE caller.orgId = $orgId AND caller.workspaceId = $workspaceId
                 AND caller.publicId IN $symbolIds
                 AND callee.publicId IN $symbolIds
               RETURN caller.publicId            AS callerNodeId,
                      callee.publicId            AS calleeNodeId,
                      coalesce(caller.name, caller.publicId) AS callerName,
                      coalesce(callee.name, callee.publicId) AS calleeName
               LIMIT 200`,
              { orgId, workspaceId, symbolIds: symbolNodeIds },
            );

            for (const rec of callResult.records) {
              callRows.push({
                callerNodeId: rec.get("callerNodeId") as string,
                calleeNodeId: rec.get("calleeNodeId") as string,
                callerName: rec.get("callerName") as string,
                calleeName: rec.get("calleeName") as string,
              });
            }
          } catch {
            // CALLS edges not yet present — degrade gracefully to empty array.
          }
        }
      }

      // ── Step 4: Recent commits that touched matched files ────────────────────
      // OPTIONAL: absent when commit-edge ingestion hasn't landed yet.
      if (wantCommits && fileNodeIds.length > 0) {
        try {
          const commitResult = await session.run(
            `MATCH (c:Commit)-[:MODIFIED]->(f:SourceFile)
             WHERE c.orgId = $orgId AND c.workspaceId = $workspaceId
               AND f.publicId IN $fileNodeIds
             WITH c, collect(coalesce(f.path, f.publicId)) AS modifiedFiles
             RETURN c.sha                                AS commitSha,
                    coalesce(c.message, '')             AS message,
                    coalesce(c.authorName, '')          AS authorName,
                    coalesce(c.committedAt, '')         AS committedAt,
                    modifiedFiles
             ORDER BY c.committedAt DESC LIMIT 20`,
            { orgId, workspaceId, fileNodeIds },
          );

          for (const rec of commitResult.records) {
            commitRows.push({
              commitSha: rec.get("commitSha") as string,
              message: rec.get("message") as string,
              authorName: rec.get("authorName") as string,
              committedAt: rec.get("committedAt") as string,
              modifiedFiles: rec.get("modifiedFiles") as string[],
            });
          }
        } catch {
          // Commit edges not yet present — degrade gracefully to empty array.
        }
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    {
      query: input.query,
      files: fileRows.length,
      symbols: symbolRows.length,
      calls: callRows.length,
      commits: commitRows.length,
      orgId,
      workspaceId,
    },
    "code.map: bundle assembled",
  );

  return {
    files: fileRows.map((f) => ({
      nodeId: f.nodeId,
      path: f.path,
      language: f.language,
      displayName: f.displayName,
      ...(f.domain !== null && f.domain !== undefined ? { domain: f.domain } : {}),
      score: f.score,
    })),
    symbols: symbolRows.map((s) => ({
      nodeId: s.nodeId,
      name: s.name,
      kind: s.kind,
      path: s.path,
      startLine: s.startLine,
      endLine: s.endLine,
      signature: s.signature,
      ...(s.docComment !== null && s.docComment !== undefined ? { docComment: s.docComment } : {}),
      ...(s.domain !== null && s.domain !== undefined ? { domain: s.domain } : {}),
      score: s.score,
    })),
    calls: callRows,
    recentChanges: commitRows,
  };
};
