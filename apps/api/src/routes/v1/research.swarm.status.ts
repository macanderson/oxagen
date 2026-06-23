import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { researchSwarmStatus } from "@oxagen/oxagen/contracts/research.swarm.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const researchSwarmStatusRoute = new Hono<AppEnv>();

researchSwarmStatusRoute.get("/", async (c) => {
  const body = researchSwarmStatus.input.parse({ swarmId: c.req.query("swarmId") });
  const ctx = capabilityContext(c);
  let out: unknown;
  try {
    out = await invoke(researchSwarmStatus.name, body, ctx, { surface: "api" });
  } catch (err) {
    // agent.subagent.aggregate throws `new Error("Fanout <id> not found")` when
    // the fanout row is absent (unknown / cross-tenant swarmId). A plain Error is
    // not caught by any specific case in the error middleware and previously fell
    // through to the catch-all 500, causing the status endpoint to 500 forever
    // for any unrecognised swarmId. Map it to a clean 404 so the client can stop
    // polling immediately rather than backing off and retrying indefinitely.
    if (err instanceof Error && /not found/i.test(err.message)) {
      throw new HTTPException(404, {
        message: `Research swarm not found: ${body.swarmId}`,
      });
    }
    throw err;
  }
  return c.json(out, 200);
});
