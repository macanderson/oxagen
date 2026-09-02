import type { CapabilityContext } from "../types";
import type {
  AgentUiRenderInput,
  AgentUiRenderOutput,
} from "@oxagen/oxagen/contracts/agent.ui.render";

export type { AgentUiRenderInput, AgentUiRenderOutput };

// componentId validation is intentionally deferred to the client-side
// chat-component-registry (apps/app). packages/ has no visibility into which
// component IDs are registered in the app shell, and importing from apps/
// would invert the dependency graph. Unknown componentIds are echoed through
// unmodified; the client registry is the validation boundary.
export async function agentUiRenderHandler(
  input: AgentUiRenderInput,
  _ctx: CapabilityContext,
): Promise<AgentUiRenderOutput> {
  return {
    render: {
      componentId: input.componentId,
      props: input.props ?? {},
    },
  };
}
