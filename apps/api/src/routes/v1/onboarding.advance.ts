import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { onboardingAdvance } from "@oxagen/oxagen/contracts/onboarding.advance";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Move the onboarding gate between wrap and run. Mounted on the org-scoped router behind session auth. */
export const onboardingAdvanceRoute = new Hono<AppEnv>();

onboardingAdvanceRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = onboardingAdvance.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(onboardingAdvance.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
