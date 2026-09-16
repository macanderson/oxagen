import { Hono } from "hono";
import { mandateGet } from "@oxagen/oxagen/contracts/mandate.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const mandateGetRoute = new Hono<AppEnv>();

mandateGetRoute.post("/", async (c) => {
  const body = mandateGet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(mandateGet.name, body, ctx, { surface: "api" });
  return c.json(out);
});
