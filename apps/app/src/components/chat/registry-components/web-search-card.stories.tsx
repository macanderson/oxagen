import type { Meta, StoryObj } from "@storybook/react-vite";
import WebSearchCard from "./web-search-card";

const meta = {
  title: "Chat/WebSearchCard",
  component: WebSearchCard,
} satisfies Meta<typeof WebSearchCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Results: Story = {
  args: {
    output: {
      results: [
        {
          title: "USS Nautilus (SSN-571) — Wikipedia",
          url: "https://en.wikipedia.org/wiki/USS_Nautilus_(SSN-571)",
          content:
            "USS Nautilus (SSN-571) was the world's first operational nuclear-powered submarine and the first to complete a submerged transit of the North Pole on 3 August 1958.",
          score: 0.98,
        },
        {
          title: "Operation Sunshine: Nautilus and the North Pole",
          url: "https://www.navalhistory.org/operation-sunshine",
          content:
            "In 1958 the Nautilus undertook a top-secret mission to cross the Arctic ice cap submerged.",
          score: 0.91,
        },
        {
          title: "Hyman G. Rickover and the Nuclear Navy",
          url: "https://www.energy.gov/articles/rickover",
          content:
            "Admiral Rickover directed the development of the naval nuclear propulsion program.",
          score: 0.84,
        },
      ],
      totalResults: 3,
      searchId: "s_1",
    },
  },
};
