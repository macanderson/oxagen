import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendOperatorRanking } from "@oxagen/oxagen/contracts/spend.operator_ranking";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Rank this workspace's operators by unproductive spend. Managers only. Mounted on the org-scoped router behind session auth. */
export const spendOperatorRankingRoute = new Hono<AppEnv>();

spendOperatorRankingRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendOperatorRanking.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendOperatorRanking.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
