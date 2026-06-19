import type { Meta, StoryObj } from "@storybook/react-vite";
import GraphIngestCard from "./graph-ingest-card";

const meta = {
  title: "Chat/GraphIngestCard",
  component: GraphIngestCard,
  args: { orgSlug: "acme", workspaceSlug: "research" },
} satisfies Meta<typeof GraphIngestCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ingested: Story = {
  args: {
    output: {
      summary: "Ingested 4 entities and 3 relationships into the knowledge graph.",
      entities: [
        { nodeId: "n_1", name: "USS Nautilus", type: "Vessel", confidence: 0.97, created: true },
        { nodeId: "n_2", name: "Hyman G. Rickover", type: "Person", confidence: 0.93, created: true },
        { nodeId: "n_3", name: "Operation Sunshine", type: "Event", confidence: 0.81, created: true },
        { nodeId: "n_4", name: "S2W Reactor", type: "Technology", confidence: 0.66, created: false },
      ],
      relationships: [
        { edgeId: "n_2:CREATED_BY:n_1", from: "Hyman G. Rickover", to: "USS Nautilus", edgeType: "CREATED_BY", confidence: 0.9, created: true },
        { edgeId: "n_1:PART_OF:n_3", from: "USS Nautilus", to: "Operation Sunshine", edgeType: "PART_OF", confidence: 0.78, created: true },
        { edgeId: "n_1:DEPENDS_ON:n_4", from: "USS Nautilus", to: "S2W Reactor", edgeType: "DEPENDS_ON", confidence: 0.55, created: true },
      ],
    },
  },
};
