import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { tachoSessionGet } from "@oxagen/oxagen/contracts/tacho.session.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one Tacho session's flight-recorder index. Mounted on the org-scoped router behind session auth. */
export const tachoSessionGetRoute = new Hono<AppEnv>();

tachoSessionGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoSessionGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoSessionGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
