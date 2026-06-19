import type { Meta, StoryObj } from "@storybook/react-vite";
import GraphEdgeCard from "./graph-edge-card";

const meta = {
  title: "Chat/GraphEdgeCard",
  component: GraphEdgeCard,
  args: { orgSlug: "acme", workspaceSlug: "research" },
} satisfies Meta<typeof GraphEdgeCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Created: Story = {
  args: { output: { edgeId: "n_rickover:CREATED_BY:n_nautilus", created: true } },
};

export const AlreadyExists: Story = {
  args: { output: { edgeId: "n_nautilus:PART_OF:n_usnavy", created: false } },
};
