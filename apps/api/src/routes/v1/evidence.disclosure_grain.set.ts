import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { evidenceDisclosureGrainSet } from "@oxagen/oxagen/contracts/evidence.disclosure_grain.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Set the workspace's witness disclosure grain. The handler answers a signed-in Owner or Admin only. */
export const evidenceDisclosureGrainSetRoute = new Hono<AppEnv>();

evidenceDisclosureGrainSetRoute.put("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = evidenceDisclosureGrainSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(evidenceDisclosureGrainSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
