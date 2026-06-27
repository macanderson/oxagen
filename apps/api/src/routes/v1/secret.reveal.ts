import { Hono } from "hono";
import { secretReveal } from "@oxagen/oxagen/contracts/secret.reveal";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretRevealRoute = new Hono<AppEnv>();

secretRevealRoute.post("/", async (c) => {
  const body = secretReveal.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretReveal.name, body, ctx, { surface: "api" });
  return c.json(out);
});
