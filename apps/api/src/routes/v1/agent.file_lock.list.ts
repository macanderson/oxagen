import { Hono } from "hono";
import { agentFileLockList } from "@oxagen/oxagen/contracts/agent.file_lock.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentFileLockListRoute = new Hono<AppEnv>();

agentFileLockListRoute.get("/", async (c) => {
  const path = c.req.query("path") ?? undefined;
  const owner = c.req.query("owner") ?? undefined;
  const repo = c.req.query("repo") ?? undefined;
  const input = agentFileLockList.input.parse({
    ...(path ? { path } : {}),
    ...(owner ? { owner } : {}),
    ...(repo ? { repo } : {}),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentFileLockList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
