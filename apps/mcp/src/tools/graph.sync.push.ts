import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphSyncPush } from "@oxagen/oxagen/contracts/graph.sync.push";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  source: graphSyncPush.input.shape.source.describe(
    "Up-sync data source: 'code' for repo code structure, 'lineage' for execution traces.",
  ),
  idempotencyKey: graphSyncPush.input.shape.idempotencyKey.describe(
    "Content-addressed envelope key (e.g. code:{repo}:{fromSHA}:{toSHA}). Re-sending the same key is a no-op.",
  ),
  nodes: graphSyncPush.input.shape.nodes.describe(
    "Nodes to upsert. Each node has a stable content-addressed key, domain labels, displayName, and properties.",
  ),
  edges: graphSyncPush.input.shape.edges.describe(
    "Edges to upsert between nodes by key. Relationship type must be uppercase (e.g. IMPORTS, CONTAINS).",
  ),
  tombstones: graphSyncPush.input.shape.tombstones.describe(
    "Node keys to soft-delete (DETACH DELETE). Use when a file is removed from git.",
  ),
};

export const metadata: ToolMetadata = {
  name: graphSyncPush.name,
  description: graphSyncPush.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphSyncPushTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphSyncPush.name, args, ctx, { surface: "mcp" });
  return graphSyncPush.output.parse(output);
}
