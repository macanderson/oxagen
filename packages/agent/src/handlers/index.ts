import type { CapabilityContext } from "../types";

// Lazy handler resolution. Each capability ships a `${name}.handler.ts`
// next to its declaration; we dynamic-import on first use so the runtime
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
const LOADERS: Record<string, LoaderEntry> = {
  execute_code: () => import("./agent.code.execute"),
  // Durable sandbox sessions — long-lived, reconnectable sandboxes that persist
  // across agent turns (clone → build → snapshot → PR). The one-shot
  // agent.code.execute and these durable peers share the @oxagen/sandbox driver.
  start_sandbox: () => import("./agent.sandbox.start"),
  run_sandbox_command: () => import("./agent.sandbox.exec"),
  snapshot_sandbox: () => import("./agent.sandbox.snapshot"),
  stop_sandbox: () => import("./agent.sandbox.stop"),
  rename_sandbox: () => import("./agent.sandbox.rename"),
  list_sandboxes: () => import("./agent.sandbox.list"),
  list_sandbox_files: () => import("./agent.sandbox_file.list"),
  list_sandbox_logs: () => import("./agent.sandbox_log.list"),
  read_sandbox_file: () => import("./agent.sandbox_file.read"),
  // Browser automation inside a durable session — all seven thin wrappers live
  // in one module (browser.ts) that drives `browserctl` via execInSession.
  navigate_page: () => import("./browser"),
  screenshot_page: () => import("./browser"),
  fill_page: () => import("./browser"),
  submit_page: () => import("./browser"),
  click_page: () => import("./browser"),
  refresh_page: () => import("./browser"),
  read_page: () => import("./browser"),
  // Cross-LLM proof-of-done: an independent vision model judges the screenshots.
  verify_feature: () => import("./agent.feature.verify"),
  // Code-execution surface peers of agent.code.execute (OXA-1352). Co-located
  // here so the whole sandboxed code surface registers through one path.
  diff_code: () => import("./code.diff"),
  patch_code: () => import("./code.patch"),
  format_code: () => import("./code.format"),
  list_agent_tools: () => import("./agent.tool.list"),
  register_mcp_server: () => import("./agent.mcp.register"),
  list_mcp_servers: () => import("./agent.mcp.list"),
  resolve_mcp_servers: () => import("./agent.mcp.resolve"),
  set_mcp_enabled: () => import("./agent.mcp.set_enabled"),
  delete_mcp_server: () => import("./agent.mcp.delete"),
  resolve_mcp_consent: () => import("./agent.mcp_consent.resolve"),
  list_mcp_consents: () => import("./agent.mcp_consent.list"),
  approve_plan: () => import("./agent.plan.approve"),
  create_plan: () => import("./agent.plan.create"),
  get_plan: () => import("./agent.plan.get"),
  list_plans: () => import("./agent.plan.list"),
  start_background_task: () => import("./agent.background_task.start"),
  get_background_task: () => import("./agent.background_task.read"),
  cancel_background_task: () => import("./agent.background_task.cancel"),
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
  list_agent_skills: () => import("./agent.skill.list"),
  load_skill: () => import("./agent.skill.load"),
  aggregate_subagents: () => import("./agent.subagent.aggregate"),
  cancel_subagent: () => import("./agent.subagent.cancel"),
  dispatch_subagent: () => import("./agent.subagent.dispatch"),
  // Agent file locking (docs/specs/agent-file-locking/plan.md §7) — manual
  // acquire/force-release/introspection over the same HOLDS_LOCK edge
  // write_file/edit_file in @oxagen/agent-engine's tools.ts acquire automatically.
  acquire_file_lock: () => import("./agent.file_lock.acquire"),
  release_file_lock: () => import("./agent.file_lock.release"),
  list_file_locks: () => import("./agent.file_lock.list"),
  get_subagent_fanout: () => import("./agent.subagent_fanout.get"),
  get_subagent_result: () => import("./agent.subagent_result.get"),
  list_subagent_siblings: () => import("./agent.subagent.siblings"),
  list_subagent_fanouts: () => import("./agent.subagent_fanout.list"),
  list_executions: () => import("./agent.execution.list"),
  get_execution_trace: () => import("./agent.trace.get"),
  debug_execution: () => import("./agent.debug.trace"),
  // Fleet-wide error triage overview — clusters ClickHouse error_events by
  // fingerprint. Pure SQL (ADR-021 §1), the counterpart to the single-execution
  // failure frame above.
  list_error_clusters: () => import("./telemetry.error.cluster"),
  get_execution_lineage: () => import("./agent.execution.lineage"),
  render_agent_ui: () => import("./agent.ui.render"),
  create_agent_def: () => import("./agent.definition.create"),
  delete_agent_def: () => import("./agent.definition.delete"),
  update_agent_def: () => import("./agent.definition.update"),
  publish_agent_def: () => import("./agent.definition.publish"),
  get_agent_def: () => import("./agent.definition.get"),
  list_agent_defs: () => import("./agent.definition.list"),
  get_a2a_card: () => import("./a2a.card.get"),
  deploy_agent: () => import("./agent.deploy"),
  create_trigger: () => import("./agent.trigger.create"),
  update_trigger: () => import("./agent.trigger.update"),
  delete_trigger: () => import("./agent.trigger.delete"),
  list_triggers: () => import("./agent.trigger.list"),
  // Agent RBAC role assignment (docs/specs/agent-rbac/spec.md §3.2) — attach/
  // detach/inspect IAM roles on an agent's delegated principal.
  assign_agent_role: () => import("./agent.role.assign"),
  revoke_agent_role: () => import("./agent.role.revoke"),
  list_agent_roles: () => import("./agent.role.list"),
  get_agent_role: () => import("./agent.role.get"),
};

/** Capability names this package supplies handlers for. Consumed by
 * `../register.ts` to bind them into the shared kernel. */
export const agentHandlerNames: string[] = Object.keys(LOADERS);

const cache = new Map<string, CapabilityHandlerFn>();

// Convert "agent.code.execute" → "agentCodeExecuteHandler", matching the
// camelCase convention used by the schema subagent's handler exports.
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
    // ADR-022 snake_case capability names ("agent.sandbox_file.list",
    // "agent.background_task.start", …) don't camelize to their module's
    // readable export name via the dot-segment derivation above — e.g.
    // "agent.sandbox_file.list" derives "agentSandbox_fileListHandler" while
    // the module exports "agentSandboxFilesListHandler". Those modules were
    // unresolvable at invoke time (the set_enabled module documents the gap
    // and worked around it with a default export; the other snake_case
    // modules had no workaround). Fall back to the module's single `*Handler`
    // function export — every handler module exports exactly one, so this is
    // unambiguous; if a module ever exports several, we still fail loudly.
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
