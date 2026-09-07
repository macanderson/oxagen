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
const LOADERS: Record<string, LoaderEntry> = {
  // Durable sandbox sessions — long-lived, reconnectable sandboxes that persist
  // across agent turns (clone → build → snapshot → PR). The one-shot
  // agent.code.execute and these durable peers share the @oxagen/sandbox driver.
  // Browser automation inside a durable session — all seven thin wrappers live
  // in one module (browser.ts) that drives `browserctl` via execInSession.
  // Cross-LLM proof-of-done: an independent vision model judges the screenshots.
  // Code-execution surface peers of agent.code.execute. Co-located
  // here so the whole sandboxed code surface registers through one path.
  list_agent_tools: () => import("./agent.tool.list"),
  register_mcp_server: () => import("./agent.mcp.register"),
  list_mcp_servers: () => import("./agent.mcp.list"),
  resolve_mcp_servers: () => import("./agent.mcp.resolve"),
  set_mcp_enabled: () => import("./agent.mcp.set_enabled"),
  delete_mcp_server: () => import("./agent.mcp.delete"),
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
  // Manual acquire/force-release/introspection over the same transactional
  // Postgres leases write_file/edit_file acquire automatically.
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
  get_a2a_card: () => import("./a2a.card.get"),
  deploy_agent: () => import("./agent.deploy"),
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

// Capabilities whose handler module exports MORE than one `*Handler` function,
// so the unique-export fallback in resolveHandler cannot pick the right one.
// browser.ts is the only such module today: all seven browser capabilities are
// thin wrappers over one shared `driveBrowser`, so they live together and each
// needs its export named here. Without this, every one of them fails to resolve
// at invoke time.
const EXPORT_NAME_OVERRIDES: Record<string, string> = {
  navigate_page: "browserNavigateHandler",
  screenshot_page: "browserScreenshotHandler",
  fill_page: "browserFillHandler",
  submit_page: "browserSubmitHandler",
  click_page: "browserClickHandler",
  refresh_page: "browserRefreshHandler",
  read_page: "browserReadHandler",
};

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
  const exportName =
    EXPORT_NAME_OVERRIDES[capName] ?? toHandlerExportName(capName);
  let handler = (mod[exportName] ?? mod.default) as
    | CapabilityHandlerFn
    | undefined;
  if (typeof handler !== "function") {
    // A snake_case capability name does not camelize to its module's readable
    // export name — "list_sandbox_files" derives "list_sandbox_filesHandler"
    // while the module exports "agentSandboxFilesListHandler". Fall back to the
    // module's single `*Handler` function export, which is unambiguous because
    // a handler module normally exports exactly one. A module with several is
    // listed in EXPORT_NAME_OVERRIDES above; anything else still fails loudly.
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
