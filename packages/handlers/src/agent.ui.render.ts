import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentUiRender } from "@oxagen/oxagen/contracts/agent.ui.render";

export const agentUiRenderHandler: CapabilityHandler<typeof agentUiRender> = async (
  input,
  _ctx,
) => {
  return {
    render: {
      componentId: input.componentId,
      props: input.props,
    },
  };
};
