import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { tachoSessionList } from "@oxagen/oxagen/contracts/tacho.session.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List Tacho sessions in this workspace. Mounted on the org-scoped router behind session auth. */
export const tachoSessionListRoute = new Hono<AppEnv>();

tachoSessionListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoSessionList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoSessionList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
