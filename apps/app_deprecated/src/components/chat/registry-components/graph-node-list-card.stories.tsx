import type { Meta, StoryObj } from "@storybook/react-vite";
import GraphNodeListCard from "./graph-node-list-card";

const meta = {
  title: "Chat/GraphNodeListCard",
  component: GraphNodeListCard,
  args: { orgSlug: "acme", workspaceSlug: "research" },
} satisfies Meta<typeof GraphNodeListCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NodeList: Story = {
  args: {
    output: {
      nodes: [
        {
          id: "n_1",
          displayName: "USS Nautilus",
          labels: ["Vessel"],
          description: "First nuclear submarine",
        },
        {
          id: "n_2",
          displayName: "Operation Sunshine",
          labels: ["Event"],
          description: "1958 Arctic voyage",
        },
        {
          id: "n_3",
          displayName: "Eugene Wilkinson",
          labels: ["Person"],
          description: "First commanding officer",
        },
      ],
      total: 3,
    },
  },
};

export const SearchResults: Story = {
  args: {
    output: {
      nodes: [
        {
          nodeId: "n_4",
          displayName: "S2W Reactor",
          label: "Technology",
          score: 0.98,
        },
        {
          nodeId: "n_5",
          displayName: "Pressurized water reactor",
          label: "Technology",
          score: 0.61,
        },
      ],
    },
  },
};
