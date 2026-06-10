import { Hono } from "hono";
import { graphCypher } from "@oxagen/oxagen/contracts/graph.cypher";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphCypherRoute = new Hono<AppEnv>();

graphCypherRoute.post("/", async (c) => {
  const body = graphCypher.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphCypher.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
