import type { Meta, StoryObj } from "@storybook/react-vite";
import WorkspaceContextPanel from "./workspace-context-panel";

const meta = {
  title: "Chat/WorkspaceContextPanel",
  component: WorkspaceContextPanel,
} satisfies Meta<typeof WorkspaceContextPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveSession: Story = {
  args: {
    sessionId: "sbx_abc123",
    orgSlug: "acme",
    workspaceSlug: "main",
    title: "Workspace files",
  },
};

export const MissingContext: Story = {
  args: {
    sessionId: "sbx_abc123",
  },
};

export const ScopedSubdirectory: Story = {
  args: {
    sessionId: "sbx_abc123",
    orgSlug: "acme",
    workspaceSlug: "main",
    path: "src",
    depth: 3,
    title: "src/",
  },
};
