import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
// Deep subpath, not the `@oxagen/agent` root: ADR-041's excision dropped the
// root re-export of this dependency-free typed-error module along with the
// subagent errors beside it. The subpath is a declared package export and
// pulls in no handler code (no drizzle, no withTenantDb) — see the module
// doc in packages/agent/src/handlers/execution-errors.ts.
import { isExecutionNotFoundError } from "@oxagen/agent/handlers/execution-errors";
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
