import type { Meta, StoryObj } from "@storybook/react-vite";
import CapabilityResult from "./capability-result";

const meta = {
  title: "Chat/CapabilityResult",
  component: CapabilityResult,
} satisfies Meta<typeof CapabilityResult>;
export default meta;
type Story = StoryObj<typeof meta>;

export const GenericFallback: Story = {
  args: {
    capability: "fetch_web_page",
    output: {
      url: "https://example.com/nautilus",
      title: "USS Nautilus (SSN-571)",
      wordCount: 1240,
      statusCode: 200,
      content:
        "The world's first operational nuclear-powered submarine, commissioned in 1954.",
    },
  },
};

export const WithDeepLink: Story = {
  args: {
    capability: "some.capability",
    title: "Created record",
    output: {
      displayName: "Reactor S2W",
      count: 1200,
      active: true,
      tags: ["nuclear", "naval"],
    },
    links: [
      {
        field: "id",
        recordType: "graph.node",
        id: "n_1",
        href: "/acme/research/knowledge/graph/n_1",
        label: "Open node",
      },
    ],
  },
};
