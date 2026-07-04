import { Hono } from "hono";
import { evalRunStatus } from "@oxagen/oxagen/contracts/eval.run.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalRunStatusRoute = new Hono<AppEnv>();

evalRunStatusRoute.get("/", async (c) => {
  const runPublicId = c.req.query("runPublicId");
  const input = evalRunStatus.input.parse({ runPublicId });
  const ctx = capabilityContext(c);
  const out = await invoke(evalRunStatus.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
