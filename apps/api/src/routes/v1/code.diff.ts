import { Hono } from "hono";
import { codeDiff } from "@oxagen/oxagen/contracts/code.diff";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const codeDiffRoute = new Hono<AppEnv>();

codeDiffRoute.post("/", async (c) => {
  const body = codeDiff.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(codeDiff.name, body, ctx, { surface: "api" });
  return c.json(out);
});
