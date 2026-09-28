// snapshot.ts: what one agent may see of the published tools (lane M15;
// mcp-studio-spec, Risk classification and Tool lifecycle).
//
// The gateway compiles the published policies once per version, runs S12's
// visibility test for each imported tool once per version and agent, and
// reads the off switches and the withheld tools fresh on every request. A
// tool is served when none of them removes it.
import type { ManifestServer, ManifestTool } from "@oxagen/mcp-studio";
import {
  cedarTools,
  compilePolicies,
  toolVisibility,
  type CedarRuntime,
  type CompiledPolicySet,
} from "@oxagen/policy";
import type { OffSwitches, PublishedTools, ServedAgent, ServedLog, ServedPorts, ServedRun } from "./types";

/** The compiled policy set and the evaluator that decides with it. */
export interface Decider {
  runtime: CedarRuntime;
  policy: CompiledPolicySet;
}

/** The most entries each cache holds before it drops the oldest. */
export const CACHE_LIMIT = 64;

/** A map that drops its oldest entry past a limit. */
class Bounded<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
  }
}

/**
 * The compiled policy sets and visible tool sets of recent versions. One
 * published version never changes, so an entry stays right until it is
 * dropped.
 */
export class ServedCache {
  readonly deciders: Bounded<Decider | null>;
  readonly visible: Bounded<ReadonlySet<string>>;

  constructor(limit = CACHE_LIMIT) {
    this.deciders = new Bounded(limit);
    this.visible = new Bounded(limit);
  }
}

/** Every imported tool with its server, ordered by server name, then by full tool name. */
export interface ServedTool {
  server: ManifestServer;
  /** The key in the server's tools: create_refund. */
  key: string;
  tool: ManifestTool;
}

/** The published tools as one agent sees them for one request. */
export interface ServedView {
  published: PublishedTools | null;
  run: ServedRun;
  /** Null when the key's host matches no agent, which serves no tool. */
  agent: ServedAgent | null;
  /** Null when the policies did not compile or Cedar is not installed, which denies every call. */
  decider: Decider | null;
  off: OffSwitches;
  withheld: ReadonlySet<string>;
  /** Full names of the tools the policies let this agent see. */
  visible: ReadonlySet<string>;
  /** Every imported tool, in serving order. */
  tools: readonly ServedTool[];
}

/**
 * The agent a run belongs to: the one agent/v1 whose runtime is the host's.
 * When several share the runtime, the session's harness picks one. Anything
 * else matches no agent, and the run is served no tool.
 */
export function matchAgent(
  agents: readonly ServedAgent[],
  runtime: string,
  harness: string | null,
): ServedAgent | null {
  const onRuntime = agents.filter((agent) => agent.runtime === runtime);
  if (onRuntime.length === 1) return onRuntime[0] ?? null;
  if (onRuntime.length === 0 || harness === null) return null;
  const onHarness = onRuntime.filter((agent) => agent.harness === harness);
  return onHarness.length === 1 ? (onHarness[0] ?? null) : null;
}

/** Every imported tool of a manifest, ordered by server name, then by full tool name. */
export function servedTools(published: PublishedTools | null): ServedTool[] {
  const servers = [...(published?.manifest?.servers ?? [])].sort((a, b) => compare(a.name, b.name));
  const out: ServedTool[] = [];
  for (const server of servers) {
    const keys = Object.keys(server.tools).sort((a, b) => compare(server.tools[a]?.name ?? a, server.tools[b]?.name ?? b));
    for (const key of keys) {
      const tool = Object.hasOwn(server.tools, key) ? server.tools[key] : undefined;
      if (tool !== undefined) out.push({ server, key, tool });
    }
  }
  return out;
}

/** Code-point order, the same on every host. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compile the published policies, or null when they do not compile. */
export function compileDecider(published: PublishedTools, workspaceId: string, runtime: CedarRuntime, log: ServedLog): Decider | null {
  const manifest = published.manifest ?? { servers: [] };
  const tools = cedarTools(manifest);
  if (tools.skipped.length > 0) {
    log.warn("Cedar cannot read some imported tools or arguments. A skipped tool is hidden and every call to it is denied.", {
      version: published.version,
      skipped: tools.skipped,
    });
  }
  const result = compilePolicies(
    {
      workspace: workspaceId,
      policies: published.policies ?? [],
      agents: published.agents.map(({ name, operator, runtime: agentRuntime, harness }) => ({
        name,
        operator,
        runtime: agentRuntime,
        harness,
      })),
      tools: tools.tools,
    },
    runtime,
  );
  if (result.policy_set === undefined) {
    log.warn("The published policies did not compile, so the gateway serves no tool and denies every call.", {
      version: published.version,
      errors: result.errors,
    });
    return null;
  }
  return { runtime, policy: result.policy_set };
}

function decider(
  published: PublishedTools,
  run: ServedRun,
  ports: ServedPorts,
  cache: ServedCache,
  runtime: CedarRuntime | null,
): Decider | null {
  if (runtime === null) {
    ports.log.warn("Cedar's evaluator is not installed, so the gateway serves no tool and denies every call.");
    return null;
  }
  const key = `${run.workspaceId}#${published.repository}#${published.version}`;
  const cached = cache.deciders.get(key);
  if (cached !== undefined) return cached;
  const compiled = compileDecider(published, run.workspaceId, runtime, ports.log);
  cache.deciders.set(key, compiled);
  return compiled;
}

function visibleFor(
  published: PublishedTools,
  run: ServedRun,
  agent: ServedAgent,
  found: Decider,
  tools: readonly ServedTool[],
  cache: ServedCache,
): ReadonlySet<string> {
  const key = `${run.workspaceId}#${published.repository}#${published.version}#${agent.name}#${run.operatorRole ?? ""}`;
  const cached = cache.visible.get(key);
  if (cached !== undefined) return cached;
  const visible = new Set<string>();
  for (const { tool } of tools) {
    const answer = toolVisibility({
      runtime: found.runtime,
      policy: found.policy,
      agent: agent.name,
      action: tool.name,
      tier: "gateway",
      ...(run.operatorRole === undefined ? {} : { operator_role: run.operatorRole }),
    });
    if (answer.visible) visible.add(tool.name);
  }
  cache.visible.set(key, visible);
  return visible;
}

/**
 * The published tools as this run's agent sees them. The visibility test
 * runs here, when the run lists its tools, and its answer is kept for the
 * version and the agent.
 */
export async function servedView(
  published: PublishedTools | null,
  run: ServedRun,
  ports: ServedPorts,
  cache: ServedCache,
): Promise<ServedView> {
  const tools = servedTools(published);
  const agent = published === null ? null : matchAgent(published.agents, run.runtime, run.harness);
  const empty: ServedView = {
    published,
    run,
    agent,
    decider: null,
    off: { servers: new Set(), tools: new Set() },
    withheld: new Set(),
    visible: new Set(),
    tools,
  };
  if (published === null || agent === null || tools.length === 0) return empty;

  const [off, withheld, runtime] = await Promise.all([ports.off(run), ports.withheld(run), ports.cedar()]);
  const found = decider(published, run, ports, cache, runtime);
  const visible = found === null ? new Set<string>() : visibleFor(published, run, agent, found, tools, cache);
  return { ...empty, decider: found, off, withheld, visible };
}

/** Why a tool is not served, or null when it is. */
export type Unserved = "server_off" | "tool_off" | "withheld" | "hidden";

export function unserved(view: ServedView, entry: ServedTool): Unserved | null {
  if (view.off.servers.has(entry.server.name)) return "server_off";
  if (view.off.tools.has(entry.tool.name)) return "tool_off";
  if (view.withheld.has(entry.tool.name)) return "withheld";
  if (!view.visible.has(entry.tool.name)) return "hidden";
  return null;
}

/** The tools this run's agent is served, in serving order. */
export function visibleTools(view: ServedView): ServedTool[] {
  return view.tools.filter((entry) => unserved(view, entry) === null);
}
