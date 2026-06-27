/**
 * @module agents — Named agent definitions for the CLI.
 *
 * Reusable personas (system prompt + tool allowlist + model) loaded from
 * markdown or settings.json, dispatched by the fleet planner or run directly
 * with `--agent <name>`.
 */
export type { AgentDefinition } from "./types.js";
export { loadAgents, getAgent, parseFrontmatter, type LoadAgentsOptions } from "./loader.js";
export { filterToolsForAgent, toolAllowedForAgent } from "./tools.js";
export { scaffoldAgent } from "./write.js";
