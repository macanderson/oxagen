import { Hono } from "hono";
import { evalRunStart } from "@oxagen/oxagen/contracts/eval.run.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalRunStartRoute = new Hono<AppEnv>();

evalRunStartRoute.post("/", async (c) => {
  const input = evalRunStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(evalRunStart.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
