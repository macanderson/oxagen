import { Hono } from "hono";
import { codePatch } from "@oxagen/oxagen/contracts/code.patch";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const codePatchRoute = new Hono<AppEnv>();

codePatchRoute.post("/", async (c) => {
  const body = codePatch.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(codePatch.name, body, ctx, { surface: "api" });
  return c.json(out);
});
