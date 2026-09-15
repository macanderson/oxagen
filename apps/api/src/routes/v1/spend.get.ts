import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read this workspace's spend rolled up at one level over a day range. Mounted on the org-scoped router behind session auth. */
export const spendGetRoute = new Hono<AppEnv>();

spendGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendGet.name, input, ctx, { surface: "api" });
  return c.json(output);
});
