import { Hono } from "hono";
import { mandateRevoke } from "@oxagen/oxagen/contracts/mandate.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const mandateRevokeRoute = new Hono<AppEnv>();

mandateRevokeRoute.post("/", async (c) => {
  const body = mandateRevoke.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(mandateRevoke.name, body, ctx, { surface: "api" });
  return c.json(out);
});
