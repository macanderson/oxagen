import type { CapabilityContext } from "../types";

// Lazy handler resolution. Every capability in LOADERS below points at the
// module that implements it; we dynamic-import on first use so the runtime
// boot doesn't pull in every dependency chain (Docker, MCP SDK, Neo4j)
// unless the capability is actually invoked.

export type CapabilityHandlerFn = (
  input: unknown,
  ctx: CapabilityContext,
) => Promise<unknown>;

type LoaderEntry = () => Promise<
  { default?: CapabilityHandlerFn } & Record<string, unknown>
>;

// Single source of truth mapping capability name → handler module.
// Every entry is a governance capability: the governed-tool catalogue, the
// MCP registry + consent ledger, agent memory, approvals, the execution
// evidence record, the agent-definition registry, and agent RBAC. Oxagen
// governs agents; nothing here executes one (ADR-043).
const LOADERS: Record<string, LoaderEntry> = {
  list_agent_tools: () => import("./agent.tool.list"),
  register_mcp_server: () => import("./agent.mcp.register"),
  list_mcp_servers: () => import("./agent.mcp.list"),
  resolve_mcp_servers: () => import("./agent.mcp.resolve"),
  set_mcp_enabled: () => import("./agent.mcp.set_enabled"),
  delete_mcp_server: () => import("./agent.mcp.delete"),
  // The Add a provider wizard (#4132): search the MCP Registry, and OAuth for
  // a registry or custom server without leaving the dialog.
  search_mcp_registry: () => import("./agent.mcp.registry.search"),
  start_mcp_authorization: () => import("./agent.mcp.authorize.start"),
  authorize_mcp_server: () => import("./agent.mcp.authorize.complete"),
  resolve_mcp_consent: () => import("./agent.mcp_consent.resolve"),
  list_mcp_consents: () => import("./agent.mcp_consent.list"),
  recall_memory: () => import("./agent.memory.recall"),
  write_memory: () => import("./agent.memory.write"),
  list_memories: () => import("./agent.memory.list"),
  update_memory: () => import("./agent.memory.update"),
  delete_memory: () => import("./agent.memory.delete"),
  save_memory: () => import("./agent.memory.remember"),
  // Bulk memory import: parse uploaded docs → drafts, then commit the edited set.
  parse_memory_import: () => import("./agent.memory_import.parse"),
  commit_memory_import: () => import("./agent.memory_import.commit"),
  // Two-axis memory: confidence ladder promotion + the citation/evidence
  // mechanism that drives it (docs/specs/two-axis-memory).
  promote_memory: () => import("./agent.memory.promote"),
  demote_memory: () => import("./agent.memory.demote"),
  dismiss_memory_promotion: () => import("./agent.memory_promotion.dismiss"),
  suggest_promotion_rationales: () =>
    import("./agent.memory_promotion.rationales"),
  list_memory_promotions: () => import("./agent.memory_promotion.list"),
  cite_memory: () => import("./agent.memory.cite"),
  // @-mention citations: any :GraphNode a user references in chat gets the
  // same citation_count bookkeeping as automatic memory citations.
  cite_reference: () => import("./reference.cite"),
  attach_memory_evidence: () => import("./agent.memory_evidence.attach"),
  list_memory_citations: () => import("./agent.memory_citation.list"),
  get_citation_stats: () => import("./agent.memory_citation.stats"),
  resolve_approval: () => import("./agent.approval.resolve"),
  list_approvals: () => import("./agent.approval.list"),
  list_resolved_approvals: () => import("./agent.approval.list_resolved"),
  list_executions: () => import("./agent.execution.list"),
  get_execution_trace: () => import("./agent.trace.get"),
  debug_execution: () => import("./agent.debug.trace"),
  // Fleet-wide error triage overview — clusters ClickHouse error_events by
  // fingerprint. Pure SQL (ADR-021 §1), the counterpart to the single-execution
  // failure frame above.
  list_error_clusters: () => import("./telemetry.error.cluster"),
  create_agent_def: () => import("./agent.definition.create"),
  delete_agent_def: () => import("./agent.definition.delete"),
  update_agent_def: () => import("./agent.definition.update"),
  publish_agent_def: () => import("./agent.definition.publish"),
  get_agent_def: () => import("./agent.definition.get"),
  list_agent_defs: () => import("./agent.definition.list"),
  // Agent identity (MC spec §6.2, #2956): the identities table and the one
  // identity read with credentials, roles, hosts and the definition of record.
  list_agents: () => import("./agent.list"),
  get_agent: () => import("./agent.get"),
  deploy_agent: () => import("./agent.deploy"),
  // Agent RBAC role assignment (docs/specs/agent-rbac/spec.md §3.2) — attach/
  // detach/inspect IAM roles on an agent's delegated principal.
  assign_agent_role: () => import("./agent.role.assign"),
  revoke_agent_role: () => import("./agent.role.revoke"),
  list_agent_roles: () => import("./agent.role.list"),
  get_agent_role: () => import("./agent.role.get"),
  // The in-app agent on stella-serve (#2968, ADR-053): the turn, the stop
  // (#4164), the engine probe, the reply a turn left on the record (ADR-176),
  // and the two belt meta-tools outside a turn.
  ask_assistant: () => import("./assistant.ask"),
  cancel_assistant_turn: () => import("./assistant.turn.cancel"),
  get_assistant_engine: () => import("./assistant.engine.get"),
  get_assistant_reply: () => import("./assistant.reply.get"),
  // A rule authored across two sources, as one goal-shaped ask_assistant turn
  // (ADR-182).
  author_graph_rule: () => import("./graph.rule.author"),
  search_tools: () => import("./tools.search"),
  load_tools: () => import("./tools.load"),
};

/** Capability names this package supplies handlers for. Consumed by
 * `../register.ts` to bind them into the shared kernel. */
export const agentHandlerNames: string[] = Object.keys(LOADERS);

const cache = new Map<string, CapabilityHandlerFn>();

// Dot-segment camelCase derivation, e.g. "agent.code.execute" →
// "agentCodeExecuteHandler". ADR-025 renamed every capability to verb-first
// snake_case, so for current names this almost never matches a real export and
// the unique-`*Handler` fallback below is what actually resolves the module.
// It is kept as the first probe because it is exact when it does match, and it
// is the name quoted in the failure message.
function toHandlerExportName(capName: string): string {
  const parts = capName.split(".");
  const camel = parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
  return `${camel}Handler`;
}

export async function resolveHandler(
  capName: string,
): Promise<CapabilityHandlerFn> {
  const cached = cache.get(capName);
  if (cached) return cached;
  const loader = LOADERS[capName];
  if (!loader)
    throw new Error(`No handler registered for capability ${capName}`);
  const mod = await loader();
  const exportName = toHandlerExportName(capName);
  let handler = (mod[exportName] ?? mod.default) as
    | CapabilityHandlerFn
    | undefined;
  if (typeof handler !== "function") {
    // A snake_case capability name does not camelize to its module's readable
    // export name — "list_memory_citations" derives
    // "list_memory_citationsHandler" while the module exports
    // "agentMemoryCitationListHandler". Fall back to the module's single
    // `*Handler` function export, which is unambiguous because a handler module
    // exports exactly one; anything else still fails loudly.
    const named = Object.entries(mod).filter(
      (entry): entry is [string, CapabilityHandlerFn] =>
        entry[0].endsWith("Handler") && typeof entry[1] === "function",
    );
    if (named.length === 1) handler = named[0]![1];
  }
  if (typeof handler !== "function") {
    throw new Error(
      `Handler module for ${capName} did not export ${exportName}, a unique *Handler function, or default`,
    );
  }
  cache.set(capName, handler);
  return handler;
}

export async function invokeCapability(
  capName: string,
  input: unknown,
  ctx: CapabilityContext,
): Promise<unknown> {
  const handler = await resolveHandler(capName);
  return handler(input, ctx);
}
