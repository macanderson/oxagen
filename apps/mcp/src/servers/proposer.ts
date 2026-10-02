// proposer.ts: the agent behind a propose_steering call (steering-repo-spec,
// Agent use and Record changes: provenance.agent; #5134).
//
// The agent is the one the served tools decide with for the same request: the
// run comes from the gateway key and the session header (run.ts), and the
// agents/<name>.toml file on the run's runtime names the agent (matchAgent in
// snapshot.ts), read from the workspace's published steering version. So no
// tool input can name an agent, and an agent proposes under no name but its
// own. serve.ts binds this to Postgres, and middleware.ts registers it with
// the propose_steering handler (@oxagen/handlers/steering.proposer).
import type { ProposingAgent } from "@oxagen/handlers/steering.proposer";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { steeringKey, type PublishedSources } from "./published";
import { resolveServedRun, type RunSources } from "./run";
import { matchAgent } from "./snapshot";

/** Where the resolver reads the run and the published agents from. */
export interface ProposerSources {
  run: RunSources;
  published: PublishedSources;
}

/**
 * The agent and run behind a request, or null when the request belongs to no
 * run, the workspace has published no steering, or no agent file matches the
 * run's runtime and harness. The run is null when the request names no
 * session the key's machine has.
 */
export async function proposingAgentOf(
  ctx: CapabilityContext,
  sources: ProposerSources,
): Promise<ProposingAgent | null> {
  const run = await resolveServedRun(ctx, sources.run);
  if (run === null) return null;
  const scope = { orgId: run.orgId, workspaceId: run.workspaceId };
  const connection = await sources.published.connection(scope);
  if (connection === null) return null;
  const bundle = await sources.published.current(scope, steeringKey(connection));
  // A version with no workspace slug belongs to an organization repository,
  // which serves no agent here (publishedTools in published.ts).
  if (bundle === null || bundle.workspace === undefined) return null;
  const agent = matchAgent(bundle.agents, run.runtime, run.harness);
  return agent === null ? null : { agent: agent.name, run: run.runPublicId };
}
