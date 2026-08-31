import { Hono } from "hono";
import { contextRecordPromote } from "@oxagen/oxagen/contracts/context.record.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const contextRecordPromoteRoute = new Hono<AppEnv>();

contextRecordPromoteRoute.post("/", async (c) => {
  const input = contextRecordPromote.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(contextRecordPromote.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
