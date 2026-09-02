import type { Meta, StoryObj } from "@storybook/react-vite";
import { Database, Sparkles } from "lucide-react";
import { Button } from "./button";
import { EmptyState } from "./empty-state";

const meta = {
  title: "Primitives/EmptyState",
  component: EmptyState,
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: <Database />,
    title: "No connections yet",
    description:
      "Connect a data source to start grounding agent answers in your knowledge graph.",
    action: <Button size="sm">Add connection</Button>,
    variant: "dashed",
  },
};

export const SmallMuted: Story = {
  args: {
    icon: <Sparkles />,
    title: "No suggestions",
    description: "Inferred edges will appear here.",
    size: "sm",
    variant: "muted",
  },
};
