import { Hono } from "hono";
import { secretValueUnset } from "@oxagen/oxagen/contracts/secret.value.unset";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretValueUnsetRoute = new Hono<AppEnv>();

secretValueUnsetRoute.post("/", async (c) => {
  const body = secretValueUnset.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretValueUnset.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
