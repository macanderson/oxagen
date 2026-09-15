import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Get the runs, calls and prices one finding cites. Mounted on the org-scoped router behind session auth. */
export const findingEvidenceGetRoute = new Hono<AppEnv>();

findingEvidenceGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = findingEvidenceGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(findingEvidenceGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
