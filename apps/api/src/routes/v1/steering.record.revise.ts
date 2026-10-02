import { Hono } from "hono";
import { steeringRecordRevise } from "@oxagen/oxagen/contracts/steering.record.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const steeringRecordReviseRoute = new Hono<AppEnv>();

steeringRecordReviseRoute.post("/", async (c) => {
  const input = steeringRecordRevise.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(steeringRecordRevise.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
