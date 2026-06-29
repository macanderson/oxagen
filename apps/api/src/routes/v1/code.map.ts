import { Hono } from "hono";
import { codeMap } from "@oxagen/oxagen/contracts/code.map";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const codeMapRoute = new Hono<AppEnv>();

codeMapRoute.post("/", async (c) => {
  const body = codeMap.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(codeMap.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
