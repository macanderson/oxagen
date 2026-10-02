// steering.proposer.ts: the agent and run behind a propose_steering call
// (steering-repo-spec, Agent use and Record changes: provenance.agent).
//
// Oxagen writes the proposing agent into each record's provenance itself, so
// no tool input names it. The agent comes from the request's credential: a
// gateway key names the machine it was minted for, the machine names its
// runtime, and the agents/<name>.toml file on that runtime names the agent.
// The session header picks the file when several agents share the runtime.
//
// That resolution lives in apps/mcp (servers/run.ts and servers/snapshot.ts),
// beside the served tools that use it, and a package cannot import an app. So
// the MCP server registers a resolver here when it boots (middleware.ts), and
// the handler asks through it. Until a resolver is registered, every call
// resolves to no agent and the handler refuses it.
import type { CapabilityContext } from "@oxagen/oxagen";

/** The agent that proposes a steering change, and the run it proposes from. */
export interface ProposingAgent {
  /** The agent's name: the lineage its agents/<name>.toml file gives it, such as aintel.core.ci-reviewer. */
  agent: string;
  /** The run's public id, or null when the request names no run Oxagen watched. */
  run: string | null;
}

/** Finds the agent behind one request, or null when the request comes from no agent. */
export type ProposingAgentResolver = (
  ctx: CapabilityContext,
) => Promise<ProposingAgent | null>;

// The resolver sits on globalThis, as the capability registry does, so a
// second copy of this module (a bundler chunk, a test's module graph) reads
// the one the MCP server registered.
const RESOLVER_KEY = Symbol.for("@oxagen/handlers.proposingAgentResolver");
const store = globalThis as typeof globalThis & {
  [RESOLVER_KEY]?: ProposingAgentResolver | null;
};

/** Set the resolver propose_steering asks. Null removes it, so every call resolves to no agent. */
export function registerProposingAgentResolver(
  resolver: ProposingAgentResolver | null,
): void {
  store[RESOLVER_KEY] = resolver;
}

/** The agent behind the request, or null when no resolver is registered or the request comes from no agent. */
export async function resolveProposingAgent(
  ctx: CapabilityContext,
): Promise<ProposingAgent | null> {
  const resolver = store[RESOLVER_KEY] ?? null;
  return resolver === null ? null : resolver(ctx);
}
