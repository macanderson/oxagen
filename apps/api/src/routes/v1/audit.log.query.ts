import { Hono } from "hono";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const auditLogQueryRoute = new Hono<AppEnv>();

auditLogQueryRoute.post("/", async (c) => {
  const body = auditLogQuery.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(auditLogQuery.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
