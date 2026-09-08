import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the Tacho hosts enrolled in this workspace. Mounted on the org-scoped router behind session auth. */
export const tachoHostListRoute = new Hono<AppEnv>();

tachoHostListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoHostList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoHostList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
