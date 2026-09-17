import type { Meta, StoryObj } from "@storybook/react-vite";
import GraphNodeCard from "./graph-node-card";

const meta = {
  title: "Chat/GraphNodeCard",
  component: GraphNodeCard,
} satisfies Meta<typeof GraphNodeCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NodeDetail: Story = {
  args: {
    output: {
      node: {
        nodeId: "n_7",
        label: "Person",
        displayName: "Hyman G. Rickover",
        description: "Admiral; the 'Father of the Nuclear Navy'.",
        properties: {
          rank: "Admiral",
          born: "1900",
          role: "Director, Naval Reactors",
        },
      },
    },
    links: [
      {
        field: "node.nodeId",
        recordType: "graph.node",
        id: "n_7",
        href: "/acme/research/knowledge/graph/n_7",
        label: "Hyman G. Rickover",
      },
    ],
  },
};

export const NewlyCreated: Story = {
  args: {
    output: { nodeId: "n_9", created: true },
    links: [
      {
        field: "nodeId",
        recordType: "graph.node",
        id: "n_9",
        href: "/acme/research/knowledge/graph/n_9",
        label: "n_9",
      },
    ],
  },
};
