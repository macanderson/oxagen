import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one operator, agent or tool's spend over a trailing window. Mounted on the org-scoped router behind session auth. */
export const spendDrillRoute = new Hono<AppEnv>();

spendDrillRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendDrill.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendDrill.name, input, ctx, { surface: "api" });
  return c.json(output);
});
