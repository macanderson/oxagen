import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { graphRuleAuthor } from "@oxagen/oxagen/contracts/graph.rule.author";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * A relationship rule across two sources, authored as one goal-shaped
 * assistant turn and run to completion (ADR-186).
 */
export const graphRuleAuthorRoute = new Hono<AppEnv>();

graphRuleAuthorRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = graphRuleAuthor.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(graphRuleAuthor.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
