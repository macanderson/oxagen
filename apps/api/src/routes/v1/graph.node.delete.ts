import { Hono } from "hono";
import { graphNodeDelete } from "@oxagen/oxagen/contracts/graph.node.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphNodeDeleteRoute = new Hono<AppEnv>();

graphNodeDeleteRoute.delete("/:nodeId", async (c) => {
  const body = graphNodeDelete.input.parse({ nodeId: c.req.param("nodeId") });
  const ctx = capabilityContext(c);
  const out = await invoke(graphNodeDelete.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
