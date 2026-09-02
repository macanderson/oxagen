import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isFanoutNotFoundError } from "@oxagen/agent";
import { researchSwarmStatus } from "@oxagen/oxagen/contracts/research.swarm.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const researchSwarmStatusRoute = new Hono<AppEnv>();

researchSwarmStatusRoute.get("/", async (c) => {
  const body = researchSwarmStatus.input.parse({
    swarmId: c.req.query("swarmId"),
  });
  const ctx = capabilityContext(c);
  let out: unknown;
  try {
    out = await invoke(researchSwarmStatus.name, body, ctx, { surface: "api" });
  } catch (err) {
    // agent.subagent.aggregate throws a typed FanoutNotFoundError when the fanout
    // row is absent (unknown / cross-tenant swarmId). A plain throw is not caught
    // by any specific case in the error middleware and would fall through to the
    // catch-all 500 — which made the status endpoint 500 forever for any
    // unrecognised swarmId and the client poller loop on it. Match the TYPED error
    // (not a brittle error-message regex, which would over-match any unrelated
    // "not found" error and wrongly mark a live swarm failed) and map it to a
    // clean 404 so the client stops polling immediately.
    if (isFanoutNotFoundError(err)) {
      throw new HTTPException(404, {
        message: `Research swarm not found: ${body.swarmId}`,
      });
    }
    throw err;
  }
  return c.json(out, 200);
});
