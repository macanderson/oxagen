import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { onboardingFirstFrameGet } from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The first frame for one registered agent, long-polled. Mounted on the org-scoped router behind session auth. */
export const onboardingFirstFrameGetRoute = new Hono<AppEnv>();

onboardingFirstFrameGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = onboardingFirstFrameGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(onboardingFirstFrameGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
