import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isFanoutNotFoundError } from "@oxagen/agent";
import { lineageQuery } from "@oxagen/oxagen/contracts/lineage.query";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const lineageQueryRoute = new Hono<AppEnv>();

// GET /:dispatchId?maxDepth=N&maxNodes=N — the dispatch tree rooted at one
// agent.subagent_fanouts row (issue #1078), the data spine for the
// fleet-lineage explorer. Path param + optional numeric query caps mirrors
// agent.debug.trace.ts's shape.
lineageQueryRoute.get("/:dispatchId", async (c) => {
  const maxDepthRaw = c.req.query("maxDepth");
  const maxNodesRaw = c.req.query("maxNodes");
  const input = lineageQuery.input.parse({
    dispatchId: c.req.param("dispatchId"),
    maxDepth: maxDepthRaw !== undefined ? Number(maxDepthRaw) : undefined,
    maxNodes: maxNodesRaw !== undefined ? Number(maxNodesRaw) : undefined,
  });
  const ctx = capabilityContext(c);
  try {
    const out = await invoke(lineageQuery.name, input, ctx, {
      surface: "api",
    });
    return c.json(out);
  } catch (err) {
    // Unknown or cross-tenant dispatchId is a clean 404, never a 500 — matched
    // structurally via the typed error (the handler throws FanoutNotFoundError
    // for exactly this case), mirroring agent.subagent.aggregate's route.
    if (isFanoutNotFoundError(err)) {
      throw new HTTPException(404, {
        message: `Fanout not found: ${input.dispatchId}`,
      });
    }
    throw err;
  }
});
