import { Hono } from "hono";
import { graphExport } from "@oxagen/oxagen/contracts/graph.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphExportRoute = new Hono<AppEnv>();

// POST with JSON body: the input carries arrays (labels) and a mix of optional
// filters, making a query-string encoding awkward and fragile. Following the
// same pattern as graph.search (also POST) for consistency.
graphExportRoute.post("/", async (c) => {
  const body = graphExport.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphExport.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
