import { Hono } from "hono";
import { secretValueSet } from "@oxagen/oxagen/contracts/secret.value.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretValueSetRoute = new Hono<AppEnv>();

secretValueSetRoute.post("/", async (c) => {
  const body = secretValueSet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretValueSet.name, body, ctx, { surface: "api" });
  return c.json(out);
});
