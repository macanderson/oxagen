import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isSubagentRunNotFoundError } from "@oxagen/agent";
import { agentSubagentResultGet } from "@oxagen/oxagen/contracts/agent.subagent_result.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentResultGetRoute = new Hono<AppEnv>();

agentSubagentResultGetRoute.get("/:runId", async (c) => {
  const input = agentSubagentResultGet.input.parse({
    runId: c.req.param("runId"),
  });
  const ctx = capabilityContext(c);
  try {
    const out = await invoke(agentSubagentResultGet.name, input, ctx, {
      surface: "api",
    });
    return c.json(out);
  } catch (err) {
    // Unknown or cross-tenant runId is a clean 404, never a 500 — matched
    // structurally (typed error), not via a brittle message regex.
    if (isSubagentRunNotFoundError(err)) {
      throw new HTTPException(404, {
        message: `Subagent run not found: ${input.runId}`,
      });
    }
    throw err;
  }
});
