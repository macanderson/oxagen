import type { Meta, StoryObj } from "@storybook/react-vite";
import CapabilityChainCard from "./capability-chain-card";

const meta = {
  title: "Chat/CapabilityChainCard",
  component: CapabilityChainCard,
} satisfies Meta<typeof CapabilityChainCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExecutedChain: Story = {
  args: {
    output: {
      goal: "Research USS Nautilus and add the key entities to the graph",
      summary:
        "Searched the web for the Nautilus, then ingested 8 entities and 5 relationships into the knowledge graph.",
      executed: true,
      steps: [
        {
          id: "step1",
          capability: "start_research_swarm",
          rationale: "Kick off a deep multi-query web research swarm.",
          status: "success",
          input: {
            topic: "USS Nautilus SSN-571 history crew reactor",
            depth: "deep",
          },
          output: { swarmId: "swm_1", estimatedTasks: 15 },
          durationMs: 8500,
        },
        {
          id: "step2",
          capability: "get_research_status",
          rationale: "Collect the aggregated search results.",
          status: "success",
          input: { swarmId: "$steps.step1.swarmId" },
          output: { status: "complete", completedTasks: 15, totalTasks: 15 },
          durationMs: 220,
        },
        {
          id: "step3",
          capability: "query_ontology",
          rationale:
            "Extract entities + relationships and commit to the graph.",
          status: "success",
          input: { text: "…aggregated search text…" },
          output: { entities: 8, relationships: 5 },
          durationMs: 4200,
        },
        {
          id: "step4",
          capability: "purchase_credits",
          rationale: "Would top up credits (not auto-run).",
          status: "skipped",
          input: null,
          error:
            "Capability is destructive or requires approval — not auto-executed.",
          durationMs: 0,
        },
      ],
    },
  },
};
