import { Hono } from "hono";
import { graphNodeSearch } from "@oxagen/oxagen/contracts/graph.node.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphNodeSearchRoute = new Hono<AppEnv>();

graphNodeSearchRoute.post("/", async (c) => {
  const body = graphNodeSearch.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphNodeSearch.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
