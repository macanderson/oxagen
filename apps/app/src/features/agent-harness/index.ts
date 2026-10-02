// Each agent's registered harness, for the surfaces that badge an agent's
// avatar (#4871). It is its own feature so the agents, shell, tools, spend and
// mandate barrels can all import it without importing one another; it imports
// types alone. Nothing else reaches into the folder (eslint: `@/features/*/*`
// is restricted).
export {
  type AgentHarnessIndex,
  EMPTY_HARNESS_INDEX,
  harnessOfKey,
  harnessOfSlug,
  readAgentHarnessIndex,
} from "./harness-index";
