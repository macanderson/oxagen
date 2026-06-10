import { Hono } from "hono";
import { graphNodeList } from "@oxagen/oxagen/contracts/graph.node.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphNodeListRoute = new Hono<AppEnv>();

graphNodeListRoute.get("/", async (c) => {
  const query = c.req.query();
  const body = graphNodeList.input.parse({
    labels: query.labels !== undefined ? query.labels.split(",") : undefined,
    sourceId: query.sourceId,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    offset: query.offset !== undefined ? Number(query.offset) : undefined,
    query: query.query,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(graphNodeList.name, body, ctx, { surface: "api" });
  return c.json(out);
});
