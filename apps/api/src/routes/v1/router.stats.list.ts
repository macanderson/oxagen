import { Hono } from "hono";
import { routerStatsList } from "@oxagen/oxagen/contracts/router.stats.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const routerStatsListRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/router/stats?task_class&window_days&min_samples
routerStatsListRoute.get("/", async (c) => {
  const windowDays = c.req.query("window_days");
  const minSamples = c.req.query("min_samples");
  const input = routerStatsList.input.parse({
    taskClass: c.req.query("task_class") || undefined,
    // Query params are strings — coerce the numeric filters to satisfy the contract.
    windowDays: windowDays ? Number(windowDays) : undefined,
    minSamples: minSamples ? Number(minSamples) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(routerStatsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
