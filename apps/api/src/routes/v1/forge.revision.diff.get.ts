import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { revisionDiffGet } from "@oxagen/oxagen/contracts/forge.revision.diff.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Get one pull request revision's stored diff, split into files (ADR-292). */
export const revisionDiffGetRoute = new Hono<AppEnv>();

revisionDiffGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = revisionDiffGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(revisionDiffGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
