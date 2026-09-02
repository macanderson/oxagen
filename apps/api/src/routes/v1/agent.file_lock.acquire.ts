import { Hono } from "hono";
import { agentFileLockAcquire } from "@oxagen/oxagen/contracts/agent.file_lock.acquire";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentFileLockAcquireRoute = new Hono<AppEnv>();

agentFileLockAcquireRoute.post("/", async (c) => {
  const body = agentFileLockAcquire.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentFileLockAcquire.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
