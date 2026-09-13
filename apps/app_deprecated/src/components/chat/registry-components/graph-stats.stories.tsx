import type { Meta, StoryObj } from "@storybook/react-vite";
import GraphStatsBlock from "./graph-stats";

const meta = {
  title: "Chat/GraphStatsBlock",
  component: GraphStatsBlock,
} satisfies Meta<typeof GraphStatsBlock>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A populated graph.stats result — node/edge/source counts with a last-modified timestamp. */
export const Populated: Story = {
  args: {
    nodeCount: 12_480,
    edgeCount: 38_712,
    inferredEdgeCount: 4_206,
    sourceCount: 7,
    lastModifiedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  },
};

/** A brand-new workspace with an empty graph — all counts zero. */
export const Empty: Story = {
  args: {
    nodeCount: 0,
    edgeCount: 0,
    inferredEdgeCount: 0,
    sourceCount: 0,
  },
};
