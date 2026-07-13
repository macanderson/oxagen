import { Hono } from "hono";
import { evalRunList } from "@oxagen/oxagen/contracts/eval.run.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalRunListRoute = new Hono<AppEnv>();

evalRunListRoute.get("/", async (c) => {
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");
  const input = evalRunList.input.parse({
    datasetPublicId: c.req.query("datasetPublicId") ?? undefined,
    since: c.req.query("since") ?? undefined,
    until: c.req.query("until") ?? undefined,
    status: c.req.query("status") ?? undefined,
    model: c.req.query("model") ?? undefined,
    sortBy: c.req.query("sortBy") ?? undefined,
    sortDir: c.req.query("sortDir") ?? undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(evalRunList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
