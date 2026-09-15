import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List this workspace's costed findings ranked by the money at stake. Mounted on the org-scoped router behind session auth. */
export const findingListRoute = new Hono<AppEnv>();

findingListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = findingList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(findingList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
