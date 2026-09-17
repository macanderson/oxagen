import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The sidebar's counts: pending approvals, proposals, incidents. */
export const shellNavCountsGetRoute = new Hono<AppEnv>();

shellNavCountsGetRoute.get("/", async (c) => {
  let rawInput: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      rawInput = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
  }
  const input = shellNavCountsGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(shellNavCountsGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
