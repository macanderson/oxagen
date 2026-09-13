import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ToolCell } from "./tool-cell";

const meta = {
  title: "Mission Control/ToolCell",
  component: ToolCell,
  tags: ["autodocs"],
  args: { tool: "github__merge_pull_request@2.3.0" },
} satisfies Meta<typeof ToolCell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LabelFirst: Story = {};

export const ApiNameFirst: Story = { args: { names: "api", sub: "41 calls" } };

export const RegistryLabelAndCategory: Story = {
  args: {
    tool: "stripe__create_payment@1.0.0",
    label: "Charge a customer",
    category: "finance",
  },
};

export const Small: Story = {
  args: { tool: "slack__post_message", size: "sm" },
};

export const EveryCategory: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {[
        "github__get_file_contents",
        "snowflake__query_warehouse",
        "linear__update_issue",
        "slack__post_message",
        "drive__trash_file",
        "bash__run",
        "github__merge_pull_request",
        "vercel__deploy_to_vercel",
        "drive__share_file",
        "stripe__refund_charge",
      ].map((tool) => (
        <ToolCell key={tool} tool={tool} />
      ))}
    </div>
  ),
};
