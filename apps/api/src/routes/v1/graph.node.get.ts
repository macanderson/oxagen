import { Hono } from "hono";
import { graphNodeGet } from "@oxagen/oxagen/contracts/graph.node.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphNodeGetRoute = new Hono<AppEnv>();

graphNodeGetRoute.get("/:nodeId", async (c) => {
  const body = graphNodeGet.input.parse({ nodeId: c.req.param("nodeId") });
  const ctx = capabilityContext(c);
  const out = await invoke(graphNodeGet.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
