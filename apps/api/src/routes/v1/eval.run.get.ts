import { Hono } from "hono";
import { evalRunGet } from "@oxagen/oxagen/contracts/eval.run.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalRunGetRoute = new Hono<AppEnv>();

evalRunGetRoute.get("/", async (c) => {
  const runPublicId = c.req.query("runPublicId");
  const input = evalRunGet.input.parse({ runPublicId });
  const ctx = capabilityContext(c);
  const out = await invoke(evalRunGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
