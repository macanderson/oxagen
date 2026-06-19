import { Hono } from "hono";
import { graphIngest } from "@oxagen/oxagen/contracts/graph.ingest";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphIngestRoute = new Hono<AppEnv>();

graphIngestRoute.post("/", async (c) => {
  const body = graphIngest.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(graphIngest.name, body, ctx, { surface: "api" });
  return c.json(result);
});
