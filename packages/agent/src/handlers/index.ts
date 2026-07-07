import type { CapabilityContext } from "../types";

// Lazy handler resolution. Each capability ships a `${name}.handler.ts`
// next to its declaration; we dynamic-import on first use so the runtime
// boot doesn't pull in every dependency chain (Docker, MCP SDK, Neo4j)
// unless the capability is actually invoked.

export type CapabilityHandlerFn = (
  input: unknown,
  ctx: CapabilityContext,
) => Promise<unknown>;

type LoaderEntry = () => Promise<{ default?: CapabilityHandlerFn } & Record<string, unknown>>;

// Single source of truth mapping capability name → handler module.
const LOADERS: Record<string, LoaderEntry> = {
  "agent.code.execute": () => import("./agent.code.execute"),
  // Durable sandbox sessions — long-lived, reconnectable sandboxes that persist
  // across agent turns (clone → build → snapshot → PR). The one-shot
  // agent.code.execute and these durable peers share the @oxagen/sandbox driver.
  "agent.sandbox.start": () => import("./agent.sandbox.start"),
  "agent.sandbox.exec": () => import("./agent.sandbox.exec"),
  "agent.sandbox.snapshot": () => import("./agent.sandbox.snapshot"),
  "agent.sandbox.stop": () => import("./agent.sandbox.stop"),
  "agent.sandbox.files.list": () => import("./agent.sandbox.files.list"),
  // Browser automation inside a durable session — all seven thin wrappers live
  // in one module (browser.ts) that drives `browserctl` via execInSession.
  "browser.navigate": () => import("./browser"),
  "browser.screenshot": () => import("./browser"),
  "browser.fill": () => import("./browser"),
  "browser.submit": () => import("./browser"),
  "browser.click": () => import("./browser"),
  "browser.refresh": () => import("./browser"),
  "browser.read": () => import("./browser"),
  // Cross-LLM proof-of-done: an independent vision model judges the screenshots.
  "agent.feature.verify": () => import("./agent.feature.verify"),
  // Code-execution surface peers of agent.code.execute (OXA-1352). Co-located
  // here so the whole sandboxed code surface registers through one path.
  "code.diff": () => import("./code.diff"),
  "code.patch": () => import("./code.patch"),
  "code.format": () => import("./code.format"),
  "agent.tool.list": () => import("./agent.tool.list"),
  "agent.mcp.register": () => import("./agent.mcp.register"),
  "agent.mcp.list": () => import("./agent.mcp.list"),
  "agent.mcp.set_enabled": () => import("./agent.mcp.set_enabled"),
  "agent.mcp.delete": () => import("./agent.mcp.delete"),
  "agent.mcp.consent.resolve": () => import("./agent.mcp.consent.resolve"),
  "agent.mcp.consent.list": () => import("./agent.mcp.consent.list"),
  "agent.plan.approve": () => import("./agent.plan.approve"),
  "agent.plan.create": () => import("./agent.plan.create"),
  "agent.task.background.start": () => import("./agent.task.background.start"),
  "agent.task.background.read": () => import("./agent.task.background.read"),
  "agent.task.background.cancel": () => import("./agent.task.background.cancel"),
  "agent.memory.recall": () => import("./agent.memory.recall"),
  "agent.memory.write": () => import("./agent.memory.write"),
  "agent.memory.list": () => import("./agent.memory.list"),
  "agent.memory.update": () => import("./agent.memory.update"),
  "agent.memory.delete": () => import("./agent.memory.delete"),
  "agent.memory.remember": () => import("./agent.memory.remember"),
  // Bulk memory import: parse uploaded docs → drafts, then commit the edited set.
  "agent.memory.import.parse": () => import("./agent.memory.import.parse"),
  "agent.memory.import.commit": () => import("./agent.memory.import.commit"),
  // Two-axis memory: confidence ladder promotion + the citation/evidence
  // mechanism that drives it (docs/specs/two-axis-memory).
  "agent.memory.promote": () => import("./agent.memory.promote"),
  "agent.memory.promotion.candidates": () => import("./agent.memory.promotion.candidates"),
  "agent.memory.cite": () => import("./agent.memory.cite"),
  "agent.memory.evidence.attach": () => import("./agent.memory.evidence.attach"),
  "agent.memory.citations.list": () => import("./agent.memory.citations.list"),
  "agent.approval.resolve": () => import("./agent.approval.resolve"),
  "agent.skill.list": () => import("./agent.skill.list"),
  "agent.skill.load": () => import("./agent.skill.load"),
  "agent.subagent.aggregate": () => import("./agent.subagent.aggregate"),
  "agent.subagent.cancel": () => import("./agent.subagent.cancel"),
  "agent.subagent.dispatch": () => import("./agent.subagent.dispatch"),
  // Agent file locking (docs/specs/agent-file-locking/plan.md §7) — manual
  // acquire/force-release/introspection over the same HOLDS_LOCK edge
  // write_file/edit_file in @oxagen/agent-engine's tools.ts acquire automatically.
  "agent.file.lock.acquire": () => import("./agent.file.lock.acquire"),
  "agent.file.lock.release": () => import("./agent.file.lock.release"),
  "agent.file.lock.list": () => import("./agent.file.lock.list"),
  "agent.subagent.fanout.get": () => import("./agent.subagent.fanout.get"),
  "agent.subagent.result.get": () => import("./agent.subagent.result.get"),
  "agent.subagent.siblings": () => import("./agent.subagent.siblings"),
  "agent.subagent.fanout.list": () => import("./agent.subagent.fanout.list"),
  "agent.execution.list": () => import("./agent.execution.list"),
  "agent.trace.get": () => import("./agent.trace.get"),
  "agent.debug.trace": () => import("./agent.debug.trace"),
  // Fleet-wide error triage overview — clusters ClickHouse error_events by
  // fingerprint. Pure SQL (ADR-021 §1), the counterpart to the single-execution
  // failure frame above.
  "telemetry.error.cluster": () => import("./telemetry.error.cluster"),
  "agent.execution.lineage": () => import("./agent.execution.lineage"),
  "agent.ui.render": () => import("./agent.ui.render"),
  "agent.definition.create": () => import("./agent.definition.create"),
  "agent.definition.update": () => import("./agent.definition.update"),
  "agent.definition.publish": () => import("./agent.definition.publish"),
  "agent.definition.get": () => import("./agent.definition.get"),
  "agent.definition.list": () => import("./agent.definition.list"),
  "a2a.card.get": () => import("./a2a.card.get"),
  "agent.deploy": () => import("./agent.deploy"),
  "agent.trigger.create": () => import("./agent.trigger.create"),
  "agent.trigger.update": () => import("./agent.trigger.update"),
  "agent.trigger.delete": () => import("./agent.trigger.delete"),
  "agent.trigger.list": () => import("./agent.trigger.list"),
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

export async function resolveHandler(capName: string): Promise<CapabilityHandlerFn> {
  const cached = cache.get(capName);
  if (cached) return cached;
  const loader = LOADERS[capName];
  if (!loader) throw new Error(`No handler registered for capability ${capName}`);
  const mod = await loader();
  const exportName = toHandlerExportName(capName);
  const handler = (mod[exportName] ?? mod.default) as CapabilityHandlerFn | undefined;
  if (typeof handler !== "function") {
    throw new Error(`Handler module for ${capName} did not export ${exportName} or default`);
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
