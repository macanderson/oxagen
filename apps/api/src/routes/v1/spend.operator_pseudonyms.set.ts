import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendOperatorPseudonymsSet } from "@oxagen/oxagen/contracts/spend.operator_pseudonyms.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Turn the workspace's operator pseudonyms on or off. Mounted on the org-scoped router behind session auth. */
export const spendOperatorPseudonymsSetRoute = new Hono<AppEnv>();

spendOperatorPseudonymsSetRoute.put("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendOperatorPseudonymsSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendOperatorPseudonymsSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
