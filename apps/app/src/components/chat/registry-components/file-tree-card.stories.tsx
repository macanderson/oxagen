import type { Meta, StoryObj } from "@storybook/react-vite";
import FileTreeCard from "./file-tree-card";

const meta = {
  title: "Chat/FileTreeCard",
  component: FileTreeCard,
} satisfies Meta<typeof FileTreeCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceTree: Story = {
  args: {
    title: "Workspace",
    entries: [
      { path: "README.md", kind: "file", sizeBytes: 2048 },
      { path: "package.json", kind: "file", sizeBytes: 1024 },
      { path: "src/index.ts", kind: "file", sizeBytes: 512, changed: true },
      { path: "src/lib/greet.ts", kind: "file", sizeBytes: 640, changed: true },
      { path: "src/lib/greet.test.ts", kind: "file", sizeBytes: 480 },
      {
        path: "src/routes/health.ts",
        kind: "file",
        sizeBytes: 300,
        changed: true,
      },
    ],
  },
};

export const NoChanges: Story = {
  args: {
    entries: [
      { path: "docs/README.md", kind: "file", sizeBytes: 4096 },
      { path: "docs/adr/0001-storage.md", kind: "file", sizeBytes: 2048 },
    ],
  },
};

export const Empty: Story = {
  args: { entries: [] },
};
