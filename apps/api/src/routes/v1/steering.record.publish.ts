import { Hono } from "hono";
import { steeringRecordPublish } from "@oxagen/oxagen/contracts/steering.record.publish";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const steeringRecordPublishRoute = new Hono<AppEnv>();

steeringRecordPublishRoute.post("/", async (c) => {
  const input = steeringRecordPublish.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(steeringRecordPublish.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
