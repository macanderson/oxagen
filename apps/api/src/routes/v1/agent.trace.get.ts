import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isExecutionNotFoundError } from "@oxagen/agent";
import { agentTraceGet } from "@oxagen/oxagen/contracts/agent.trace.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTraceGetRoute = new Hono<AppEnv>();

agentTraceGetRoute.get("/:executionId", async (c) => {
  const input = agentTraceGet.input.parse({
    executionId: c.req.param("executionId"),
  });
  const ctx = capabilityContext(c);
  try {
    const out = await invoke(agentTraceGet.name, input, ctx, {
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
