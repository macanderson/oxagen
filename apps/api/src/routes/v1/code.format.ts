import { Hono } from "hono";
import { codeFormat } from "@oxagen/oxagen/contracts/code.format";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const codeFormatRoute = new Hono<AppEnv>();

codeFormatRoute.post("/", async (c) => {
  const body = codeFormat.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(codeFormat.name, body, ctx, { surface: "api" });
  return c.json(out);
});
