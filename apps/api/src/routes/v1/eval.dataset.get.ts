import { Hono } from "hono";
import { evalDatasetGet } from "@oxagen/oxagen/contracts/eval.dataset.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalDatasetGetRoute = new Hono<AppEnv>();

evalDatasetGetRoute.get("/", async (c) => {
  const datasetPublicId = c.req.query("datasetPublicId");
  const limit = c.req.query("limit");
  const cursor = c.req.query("cursor") ?? undefined;
  const input = evalDatasetGet.input.parse({
    datasetPublicId,
    limit: limit ? Number(limit) : undefined,
    cursor,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(evalDatasetGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
