import { Hono } from "hono";
import { graphStats } from "@oxagen/oxagen/contracts/graph.stats";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphStatsRoute = new Hono<AppEnv>();

graphStatsRoute.get("/", async (c) => {
  const query = c.req.query();
  const body = graphStats.input.parse({
    includeByType: query.includeByType === "true",
  });
  const ctx = capabilityContext(c);
  const out = await invoke(graphStats.name, body, ctx, { surface: "api" });
  return c.json(out);
});
