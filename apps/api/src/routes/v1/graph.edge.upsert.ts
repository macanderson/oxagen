import { Hono } from "hono";
import { graphEdgeUpsert } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphEdgeUpsertRoute = new Hono<AppEnv>();

graphEdgeUpsertRoute.post("/", async (c) => {
  const body = graphEdgeUpsert.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphEdgeUpsert.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});
