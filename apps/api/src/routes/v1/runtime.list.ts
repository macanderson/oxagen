import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runtimeList } from "@oxagen/oxagen/contracts/runtime.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the workspace's runtimes with the live agents, harnesses and host enrollments on each. Mounted on the org-scoped router behind session auth. */
export const runtimeListRoute = new Hono<AppEnv>();

runtimeListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runtimeList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runtimeList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
