import type { Meta, StoryObj } from "@storybook/react-vite";
import { PRInspectionCard } from "./pr-inspection-card";

const meta = {
  title: "Chat/PRInspectionCard",
  component: PRInspectionCard,
} satisfies Meta<typeof PRInspectionCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An open PR with a changed-files breakdown that expands to per-file additions/deletions. */
export const OpenWithFiles: Story = {
  args: {
    pr: {
      number: 745,
      title: "feat(chat): sandbox detail terminal stories",
      url: "https://github.com/oxageninc/oxagen-platform/pull/745",
      branch: "feat/sandbox-detail-terminal-stories",
      state: "open",
      author: "macanderson",
      createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      description:
        "Adds Storybook stories for chat card components that currently lack them.",
      files: [
        { name: "apps/app/src/components/chat/approval-card.stories.tsx", changes: 48, additions: 48, deletions: 0 },
        { name: "apps/app/src/components/chat/plan-card.stories.tsx", changes: 92, additions: 92, deletions: 0 },
        { name: "apps/app/src/components/chat/registry-components/ci-status-card.stories.tsx", changes: 41, additions: 41, deletions: 0 },
      ],
    },
    onViewDiff: () => {},
  },
};

/** A merged PR with no per-file breakdown. */
export const Merged: Story = {
  args: {
    pr: {
      number: 737,
      title: "feat: settings mobile parity",
      url: "https://github.com/oxageninc/oxagen-platform/pull/737",
      branch: "feat/settings-mobile-parity",
      state: "merged",
      author: "macanderson",
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      description: "Brings the settings screens to parity on mobile viewports.",
    },
  },
};

/** A closed (unmerged) PR. */
export const Closed: Story = {
  args: {
    pr: {
      number: 696,
      title: "chore: rename capabilities (do not merge)",
      url: "https://github.com/oxageninc/oxagen-platform/pull/696",
      branch: "chore/capability-naming",
      state: "closed",
      author: "macanderson",
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    },
  },
};
