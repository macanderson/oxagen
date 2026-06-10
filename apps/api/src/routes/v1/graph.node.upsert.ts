import { Hono } from "hono";
import { graphNodeUpsert } from "@oxagen/oxagen/contracts/graph.node.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphNodeUpsertRoute = new Hono<AppEnv>();

graphNodeUpsertRoute.post("/", async (c) => {
  const body = graphNodeUpsert.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphNodeUpsert.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});
