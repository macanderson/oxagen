import { Hono } from "hono";
import { evalRunSeries } from "@oxagen/oxagen/contracts/eval.run.series";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalRunSeriesRoute = new Hono<AppEnv>();

evalRunSeriesRoute.get("/", async (c) => {
  const input = evalRunSeries.input.parse({
    datasetPublicId: c.req.query("datasetPublicId") ?? undefined,
    since: c.req.query("since") ?? undefined,
    until: c.req.query("until") ?? undefined,
    bucket: c.req.query("bucket") ?? undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(evalRunSeries.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
