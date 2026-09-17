import { Hono } from "hono";
import { onboardingStateGet } from "@oxagen/oxagen/contracts/onboarding.state.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Where the signed-in person is in the onboarding gate. Mounted twice: on the
 * auth-only /v1 group (no organization yet → `organization`) and on the
 * org-only group (the organization's gate row). The context requires neither
 * scope; the handler reads whichever the router set.
 */
export const onboardingStateGetRoute = new Hono<AppEnv>();

onboardingStateGetRoute.post("/", async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const input = onboardingStateGet.input.parse(raw);
  const ctx = capabilityContext(c, { requireOrg: false });
  const output = await invoke(onboardingStateGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
