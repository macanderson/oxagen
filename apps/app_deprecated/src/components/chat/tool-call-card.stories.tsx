import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolCallCard } from "./tool-call-card";

const meta = {
  title: "Chat/ToolCallCard",
  component: ToolCallCard,
} satisfies Meta<typeof ToolCallCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Graph query result — renders as the clipped, highlighted JSON snippet. */
export const GraphSearchResult: Story = {
  args: {
    toolCallId: "t_graph",
    capability: "search_graph",
    inputPreview: { query: "nuclear navy admirals", limit: 10 },
    riskLevel: "low",
    status: "completed",
    durationMs: 640,
    defaultOpen: true,
    output: {
      nodes: [
        {
          nodeId: "n_7",
          label: "Person",
          displayName: "Hyman G. Rickover",
          score: 0.94,
          properties: {
            rank: "Admiral",
            born: "1900",
            role: "Director, Naval Reactors",
          },
        },
        {
          nodeId: "n_12",
          label: "Person",
          displayName: "Chester W. Nimitz",
          score: 0.81,
          properties: { rank: "Fleet Admiral", born: "1885" },
        },
        {
          nodeId: "n_31",
          label: "Organization",
          displayName: "Naval Reactors",
          score: 0.77,
          properties: { founded: "1949", type: "government-program" },
        },
      ],
      total: 3,
      tookMs: 41,
    },
  },
};

/** Non-graph result — keeps the structured chip/grid tree. */
export const StructuredResult: Story = {
  args: {
    toolCallId: "t_msg",
    capability: "send_message",
    inputPreview: { channel: "#general", text: "deploy done" },
    riskLevel: "low",
    status: "completed",
    durationMs: 120,
    defaultOpen: true,
    output: { messageId: "msg_8f2ka91xq3", delivered: true },
  },
};
