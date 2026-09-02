import type { Meta, StoryObj } from "@storybook/react-vite";
import ResearchSwarmCard from "./research-swarm-card";

const meta = {
  title: "Chat/ResearchSwarmCard",
  component: ResearchSwarmCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ResearchSwarmCard>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: {
    output: {
      swarmId: "swm_1",
      status: "running",
      completedTasks: 6,
      totalTasks: 15,
    },
  },
};

export const CompleteWithHits: Story = {
  args: {
    output: {
      swarmId: "swm_2",
      status: "complete",
      completedTasks: 3,
      totalTasks: 3,
      results: [
        {
          query: "USS Nautilus crew members",
          resultCount: 2,
          hits: [
            {
              title: "Crew roster of SSN-571",
              url: "https://example.com/crew",
              snippet:
                "The first crew of the Nautilus served under Commander Eugene Wilkinson.",
            },
            {
              title: "Plankowners",
              url: "https://example.com/plankowners",
              snippet: "Original commissioning crew.",
            },
          ],
        },
        {
          query: "Nautilus Arctic voyage 1958",
          resultCount: 1,
          hits: [
            {
              title: "Operation Sunshine — under the ice",
              url: "https://example.com/arctic",
              snippet:
                "In August 1958 the Nautilus became the first vessel to reach the North Pole submerged.",
            },
          ],
        },
      ],
    },
  },
};

export const Failed: Story = {
  args: {
    output: {
      swarmId: "swm_3",
      status: "failed",
      completedTasks: 0,
      totalTasks: 4,
    },
  },
};
