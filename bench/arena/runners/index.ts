/**
 * Agent Runner Registry
 *
 * Central registry for all agent runners.
 */

import { OxagenRunner } from "./oxagen-runner.js";
import { StellaRunner } from "./stella-runner.js";
import { ClaudeCodeRunner } from "./claude-code-runner.js";
import type { AgentType } from "../src/lib/types.js";
import type { AgentRunner } from "./agent-runner.js";

export const runners: Record<AgentType, () => AgentRunner> = {
  oxagen: () => new OxagenRunner(),
  stella: () => new StellaRunner(),
  "claude-code": () => new ClaudeCodeRunner(),
  custom: () => {
    throw new Error("Custom runners must be registered explicitly");
  },
};

export function getRunner(agentType: AgentType): AgentRunner {
  // Cast through `| undefined`: an out-of-range string may reach here at
  // runtime even though the type says the key is always present.
  const factory = runners[agentType] as (() => AgentRunner) | undefined;
  if (!factory) {
    throw new Error(`No runner registered for agent type: ${agentType}`);
  }
  return factory();
}

export { OxagenRunner, StellaRunner, ClaudeCodeRunner };
export type { AgentRunner, BaseAgentRunner } from "./agent-runner.js";
