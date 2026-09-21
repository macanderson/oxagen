import { Hono } from "hono";
import { contextRecordRevise } from "@oxagen/oxagen/contracts/context.record.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const contextRecordReviseRoute = new Hono<AppEnv>();

contextRecordReviseRoute.post("/", async (c) => {
  const input = contextRecordRevise.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(contextRecordRevise.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
