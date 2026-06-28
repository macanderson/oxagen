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
  // Browser automation inside a durable session — all seven thin wrappers live
  // in one module (browser.ts) that drives `browserctl` via execInSession.
  "browser.navigate": () => import("./browser"),
  "browser.screenshot": () => import("./browser"),
  "browser.fill": () => import("./browser"),
  "browser.submit": () => import("./browser"),
  "browser.click": () => import("./browser"),
  "browser.refresh": () => import("./browser"),
  "browser.read": () => import("./browser"),
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
  "agent.approval.resolve": () => import("./agent.approval.resolve"),
  "agent.skill.list": () => import("./agent.skill.list"),
  "agent.skill.load": () => import("./agent.skill.load"),
  "agent.subagent.aggregate": () => import("./agent.subagent.aggregate"),
  "agent.subagent.cancel": () => import("./agent.subagent.cancel"),
  "agent.subagent.dispatch": () => import("./agent.subagent.dispatch"),
  "agent.subagent.fanout.get": () => import("./agent.subagent.fanout.get"),
  "agent.subagent.fanout.list": () => import("./agent.subagent.fanout.list"),
  "agent.ui.render": () => import("./agent.ui.render"),
  "agent.definition.create": () => import("./agent.definition.create"),
  "agent.definition.update": () => import("./agent.definition.update"),
  "agent.definition.publish": () => import("./agent.definition.publish"),
  "agent.definition.get": () => import("./agent.definition.get"),
  "agent.definition.list": () => import("./agent.definition.list"),
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
