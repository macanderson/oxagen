import { Hono } from "hono";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgListRoute = new Hono<AppEnv>();

orgListRoute.post("/", async (c) => {
  // Pre-org call: the body is empty ({}). Tolerate a missing/empty JSON body.
  const raw: unknown = await c.req.json().catch(() => ({}));
  const body = orgList.input.parse(raw);
  const ctx = capabilityContext(c, { requireOrg: false });
  const out = await invoke(orgList.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
