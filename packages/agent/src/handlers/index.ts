import type { CapabilityContext } from "../types.js";

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
  "agent.tool.list": () => import("./agent.tool.list.js"),
  "agent.code.execute": () => import("./agent.code.execute.js"),
  "agent.mcp.register": () => import("./agent.mcp.register.js"),
  "agent.mcp.list": () => import("./agent.mcp.list.js"),
  "agent.subagent.dispatch": () => import("./agent.subagent.dispatch.js"),
  "agent.subagent.aggregate": () => import("./agent.subagent.aggregate.js"),
  "agent.plan.create": () => import("./agent.plan.create.js"),
  "agent.plan.approve": () => import("./agent.plan.approve.js"),
  "agent.task.background.start": () => import("./agent.task.background.start.js"),
  "agent.task.background.read": () => import("./agent.task.background.read.js"),
  "agent.task.background.cancel": () => import("./agent.task.background.cancel.js"),
  "agent.memory.recall": () => import("./agent.memory.recall.js"),
  "agent.memory.write": () => import("./agent.memory.write.js"),
  "agent.approval.resolve": () => import("./agent.approval.resolve.js"),
  "agent.skill.list": () => import("./agent.skill.list.js"),
  "agent.skill.load": () => import("./agent.skill.load.js"),
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
