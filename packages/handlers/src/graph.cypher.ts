import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphCypher } from "@oxagen/oxagen/contracts/graph.cypher";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

// ── NL-to-Cypher schema ───────────────────────────────────────────────────────

const nlToCypherSchema = z.object({
  cypher: z.string().min(1).describe("The Cypher query to execute. Must be read-only (MATCH/RETURN only)."),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Named parameters to bind into the query"),
});

type NlToCypherResult = z.output<typeof nlToCypherSchema>;

// ── Safety guard for raw Cypher mode ─────────────────────────────────────────

// This pattern matches destructive or mutating Cypher keywords at word boundaries.
// Applied to the uppercased query to handle mixed-case input.
const DESTRUCTIVE_PATTERN = /\b(DROP|DELETE|DETACH\s+DELETE|SET|CREATE|MERGE|REMOVE|CALL\s+apoc\.)\b/;

function assertSafeCypher(cypher: string): void {
  if (DESTRUCTIVE_PATTERN.test(cypher.toUpperCase())) {
    throw new Error(
      "graph.cypher: raw Cypher mode does not allow destructive or mutating keywords " +
        "(DROP, DELETE, DETACH DELETE, SET, CREATE, MERGE, REMOVE). " +
        "Use nlQuery=true to let the model generate safe read-only Cypher, " +
        "or contact your workspace Owner for write access via nlQuery=false with a privileged API key.",
    );
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const graphCypherHandler: CapabilityHandler<typeof graphCypher> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  let cypherToRun: string;
  let mergedParams: Record<string, string | number | boolean> = input.params ?? {};

  if (input.nlQuery) {
    // Translate natural language to Cypher using @oxagen/ai.
    // The system prompt restricts the model to read-only Cypher.
    const { object } = await generateObjectFor<NlToCypherResult>({
      schema: nlToCypherSchema,
      system: `You are a Neo4j Cypher expert. Translate the user's natural-language question into a
read-only Cypher query against a knowledge graph. The graph has :KnowledgeNode nodes with
properties: publicId (UUID), orgId, workspaceId, label (string), displayName (string),
description (string?), properties (JSON string), createdAt, updatedAt.
Relationships between :KnowledgeNode nodes include:
RELATED_TO, PART_OF, CAUSED_BY, REFERENCES, SIMILAR_TO, DEPENDS_ON, CREATED_BY, MENTIONS.

RULES:
1. Output ONLY valid Cypher for read operations (MATCH + RETURN, optional WITH/WHERE/ORDER BY/LIMIT).
2. Do NOT use CREATE, MERGE, SET, DELETE, DETACH, REMOVE, DROP, or CALL apoc.* mutations.
3. Always filter by orgId and workspaceId using parameters $orgId and $workspaceId.
4. Keep queries simple and safe. Avoid APOC procedures.
5. Limit results to at most 50 rows unless the user explicitly asks for more.

Return a JSON object with fields:
- cypher: the Cypher query string
- params: optional additional named parameters (do NOT include orgId/workspaceId — those are injected automatically)`,
      prompt: input.query,
      temperature: 0,
      telemetry: {
        orgId,
        workspaceId,
        surface: ctx.surface as "api" | "mcp",
        messageId: ctx.messageId ?? ctx.requestId,
      },
    });

    cypherToRun = object.cypher;
    mergedParams = { ...mergedParams, ...(object.params ?? {}) };

    // Belt-and-suspenders: even for model-generated Cypher, reject mutations.
    assertSafeCypher(cypherToRun);
  } else {
    // Raw Cypher mode — reject destructive statements (writes require explicit
    // elevation through the LLM-sandboxed path or a dedicated mutation capability).
    assertSafeCypher(input.query);
    cypherToRun = input.query;
  }

  type RowRecord = Record<string, unknown>;
  const resultRows: RowRecord[] = [];
  let columns: string[] = [];

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(cypherToRun, mergedParams);

      if (result.records.length > 0) {
        columns = result.records[0]?.keys?.map(String) ?? [];
        for (const record of result.records) {
          const row: RowRecord = {};
          for (const key of columns) {
            row[key] = record.get(key);
          }
          resultRows.push(row);
        }
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    {
      nlQuery: input.nlQuery,
      rowCount: resultRows.length,
      columns,
      orgId,
      workspaceId,
    },
    "graph.cypher: query executed",
  );

  return {
    rows: resultRows,
    columns,
    rowCount: resultRows.length,
  };
};
