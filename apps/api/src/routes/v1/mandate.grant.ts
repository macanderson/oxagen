import { Hono } from "hono";
import { mandateGrant } from "@oxagen/oxagen/contracts/mandate.grant";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const mandateGrantRoute = new Hono<AppEnv>();

mandateGrantRoute.post("/", async (c) => {
  const body = mandateGrant.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(mandateGrant.name, body, ctx, { surface: "api" });
  return c.json(out);
});
