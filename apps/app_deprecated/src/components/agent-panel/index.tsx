/**
 * agent-panel barrel — exports the unified Linear-style in-app AI agent panel
 * and its state management.
 */
export {
  InAppAgentPanel,
  type InAppAgentPanelProps,
} from "./in-app-agent-panel";
export {
  AgentPanelStoreProvider,
  useAgentPanelStore,
} from "./use-agent-panel-store";
export type {
  PanelVisibility,
  PanelSizeMode,
  AgentStatus,
  AgentPanelState,
  AgentPanelActions,
  AgentPanelStore,
} from "./use-agent-panel-store";
export { AgentBottomBar } from "./agent-bottom-bar";
