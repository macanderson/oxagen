import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isFanoutNotFoundError } from "@oxagen/agent";
import { agentSubagentAggregate } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentAggregateRoute = new Hono<AppEnv>();

agentSubagentAggregateRoute.post("/", async (c) => {
  const body = agentSubagentAggregate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  try {
    const out = await invoke(agentSubagentAggregate.name, body, ctx, {
      surface: "api",
    });
    return c.json(out);
  } catch (err) {
    // Unknown or cross-tenant fanoutId is a clean 404, never a 500 — matched
    // structurally via the typed error (the handler throws FanoutNotFoundError
    // for exactly this case), mirroring the research.swarm.status and
    // agent.subagent.result.get routes.
    if (isFanoutNotFoundError(err)) {
      throw new HTTPException(404, {
        message: `Fanout not found: ${body.fanoutId}`,
      });
    }
    throw err;
  }
});
