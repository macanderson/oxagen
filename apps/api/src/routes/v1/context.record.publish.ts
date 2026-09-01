import { Hono } from "hono";
import { contextRecordPublish } from "@oxagen/oxagen/contracts/context.record.publish";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const contextRecordPublishRoute = new Hono<AppEnv>();

contextRecordPublishRoute.post("/", async (c) => {
  const input = contextRecordPublish.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(contextRecordPublish.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
