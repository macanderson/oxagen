import { Hono } from "hono";
import { graphEdgeDelete } from "@oxagen/oxagen/contracts/graph.edge.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphEdgeDeleteRoute = new Hono<AppEnv>();

graphEdgeDeleteRoute.delete("/", async (c) => {
  const body = graphEdgeDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphEdgeDelete.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
