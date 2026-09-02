import { Hono } from "hono";
import { agentFileLockRelease } from "@oxagen/oxagen/contracts/agent.file_lock.release";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentFileLockReleaseRoute = new Hono<AppEnv>();

agentFileLockReleaseRoute.post("/", async (c) => {
  const body = agentFileLockRelease.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentFileLockRelease.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
