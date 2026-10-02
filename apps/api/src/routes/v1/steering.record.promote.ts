import { Hono } from "hono";
import { steeringRecordPromote } from "@oxagen/oxagen/contracts/steering.record.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const steeringRecordPromoteRoute = new Hono<AppEnv>();

steeringRecordPromoteRoute.post("/", async (c) => {
  const input = steeringRecordPromote.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(steeringRecordPromote.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
