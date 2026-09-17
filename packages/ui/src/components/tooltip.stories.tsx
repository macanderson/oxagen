import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipProvider,
} from "./tooltip";
import { Button } from "./button";

const meta = {
  title: "Overlays/Tooltip",
  component: Tooltip,
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline">Hover me</Button>} />
        <TooltipPopup>Add to library</TooltipPopup>
      </Tooltip>
    </TooltipProvider>
  ),
};

/**
 * Open by default, so the tooltip bubble itself is visible in the catalog and
 * verifiable by design-sync's oracle. The hover-driven `Default` story only
 * ever proves the trigger renders.
 */
export const Open: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="outline">Hover me</Button>} />
        <TooltipPopup>Add to library</TooltipPopup>
      </Tooltip>
    </TooltipProvider>
  ),
};
