import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { changeSetGet } from "@oxagen/oxagen/contracts/forge.changes.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Get a run's, a work order's, a work item's, or an issue's pull requests and their change (ADR-292). */
export const changeSetGetRoute = new Hono<AppEnv>();

changeSetGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = changeSetGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(changeSetGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
