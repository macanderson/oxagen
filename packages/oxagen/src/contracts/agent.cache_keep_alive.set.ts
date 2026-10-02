// set_agent_cache_keep_alive — turn the cache keep-alive on or off for one
// agent in the active workspace (spend spec, detector 3; lane F32).
//
// While a parent run waits on a subagent, the tacho model proxy can resend the
// parent's last request with max_tokens 0 so its cached prompt stays warm. The
// proxy sends one only when the agent's idle cache finding shows the
// keep-alive costs less than the cache rewrites it saves. It is on by default
// (`agent.agents.cache_keep_alive`); this write lets the owning team turn it
// off for one agent, or back on.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";

export const agentCacheKeepAliveSet = registerCapability({
  name: "set_agent_cache_keep_alive",
  domain: "agent",
  description:
    "Turn the cache keep-alive on or off for one agent in the active workspace. While the agent waits on a subagent, the model proxy resends its last request with no output so its cached prompt stays warm. It runs only when the agent's idle cache finding shows the keep-alive costs less than the cache rewrites it saves. Off stops it for this agent.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      /** The agent's slug in the active workspace. */
      agent: z.string().min(1).max(128),
      /** True turns the keep-alive on; false turns it off. */
      cacheKeepAlive: z.boolean(),
    })
    .strict(),
  output: z
    .object({
      /** The agent's public id (`agt_…`). */
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      /** The setting the agent now holds. */
      cacheKeepAlive: z.boolean(),
    })
    .strict(),
});

export type AgentCacheKeepAliveSetInput = z.output<
  typeof agentCacheKeepAliveSet.input
>;
export type AgentCacheKeepAliveSetOutput = z.output<
  typeof agentCacheKeepAliveSet.output
>;
