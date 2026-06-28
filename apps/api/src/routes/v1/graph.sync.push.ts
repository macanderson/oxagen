import { Hono } from "hono";
import { graphSyncPush } from "@oxagen/oxagen/contracts/graph.sync.push";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphSyncPushRoute = new Hono<AppEnv>();

// POST with JSON body — the input carries arrays and an enum, making a
// query-string encoding fragile. Following the same pattern as graph.export
// and graph.search for consistency.
graphSyncPushRoute.post("/", async (c) => {
  const body = graphSyncPush.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphSyncPush.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
