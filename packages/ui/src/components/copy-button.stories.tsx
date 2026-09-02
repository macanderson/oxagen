import type { Meta, StoryObj } from "@storybook/react-vite";
import { TooltipProvider } from "./tooltip";
import { CopyButton } from "./copy-button";

// Explicit annotation (not `satisfies`) — the decorator return type otherwise
// infers a non-portable reference into storybook internals under tsc.
const meta: Meta<typeof CopyButton> = {
  title: "Primitives/CopyButton",
  component: CopyButton,
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof CopyButton>;

export const Default: Story = {
  args: { value: "ox_live_9f3b2a…" },
};

export const OutlineWithLabel: Story = {
  args: { value: "913d6df1-4c2a" },
  render: () => (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
      913d6df1-4c2a
      <CopyButton
        value="913d6df1-4c2a"
        label="Copy ID"
        size="icon-sm"
        variant="outline"
      />
    </div>
  ),
};
