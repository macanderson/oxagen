import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./badge";
import { KeyValueList } from "./key-value-list";

const meta = {
  title: "Primitives/KeyValueList",
  component: KeyValueList,
} satisfies Meta<typeof KeyValueList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    items: [
      {
        label: "Status",
        value: (
          <Badge variant="success-soft" dot>
            Active
          </Badge>
        ),
      },
      { label: "Region", value: "us-east-1" },
      { label: "Endpoint", value: "https://mcp.oxagen.sh/mcp" },
      { label: "Created", value: "Jun 12, 2026" },
    ],
    className: "max-w-md",
  },
};

export const Stacked: Story = {
  args: {
    stacked: true,
    items: [
      { label: "Model", value: "claude-sonnet-5" },
      { label: "Prompt hash", value: "9f3b2a1c" },
    ],
    className: "max-w-xs",
  },
};
