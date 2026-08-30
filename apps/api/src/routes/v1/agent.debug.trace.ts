import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isExecutionNotFoundError } from "@oxagen/agent";
import { agentDebugTrace } from "@oxagen/oxagen/contracts/agent.debug.trace";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDebugTraceRoute = new Hono<AppEnv>();

// GET /:executionId?summarize=true&depth=N — deterministic structured failure
// frame for one execution. `summarize=true` additionally runs one model call.
agentDebugTraceRoute.get("/:executionId", async (c) => {
  const depthRaw = c.req.query("depth");
  const input = agentDebugTrace.input.parse({
    executionId: c.req.param("executionId"),
    summarize: c.req.query("summarize") === "true" || undefined,
    depth: depthRaw !== undefined ? Number(depthRaw) : undefined,
  });
  const ctx = capabilityContext(c);
  try {
    const out = await invoke(agentDebugTrace.name, input, ctx, {
      surface: "api",
    });
    return c.json(out);
  } catch (err) {
    // Unknown or cross-tenant executionId is a clean 404, never a 500 — matched
    // structurally (typed error), not via a brittle message regex.
    if (isExecutionNotFoundError(err)) {
      throw new HTTPException(404, {
        message: `Execution not found: ${input.executionId}`,
      });
    }
    throw err;
  }
});
