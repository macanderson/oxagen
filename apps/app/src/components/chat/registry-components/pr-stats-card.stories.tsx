import type { Meta, StoryObj } from "@storybook/react-vite";
import PrStatsCard from "./pr-stats-card";

const meta = {
  title: "Chat/PrStatsCard",
  component: PrStatsCard,
} satisfies Meta<typeof PrStatsCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An open PR with comments and a failing CI section — the full repo.pr.get output. */
export const OpenWithChecks: Story = {
  args: {
    number: 745,
    title: "feat(chat): sandbox detail terminal stories",
    url: "https://github.com/oxageninc/oxagen-platform/pull/745",
    state: "open",
    draft: false,
    author: "macanderson",
    authorAvatarUrl: null,
    createdAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    body: "Adds Storybook stories for chat card components that currently lack them.",
    baseRef: "main",
    headRef: "feat/sandbox-detail-terminal-stories",
    headSha: "91e9a8ba5c1d4e2f8a7b9c0d1e2f3a4b5c6d7e8f",
    additions: 412,
    deletions: 6,
    changedFiles: 12,
    commits: 3,
    commentCount: 2,
    reviewCommentCount: 1,
    comments: [
      {
        id: "cmt_01",
        author: "reviewer-bot",
        authorAvatarUrl: null,
        body: "Nice — every card now has meaningful variants.",
        createdAt: new Date(Date.now() - 45 * 60_000).toISOString(),
        url: "https://github.com/oxageninc/oxagen-platform/pull/745#issuecomment-1",
        kind: "issue",
        path: null,
      },
      {
        id: "cmt_02",
        author: "macanderson",
        authorAvatarUrl: null,
        body: "Fixed the enum value in the CI fixture.",
        createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        url: "https://github.com/oxageninc/oxagen-platform/pull/745#discussion_r1",
        kind: "review",
        path: "apps/app/src/components/chat/registry-components/ci-status-card.stories.tsx",
      },
    ],
    ci: {
      overall: "failing",
      counts: {
        total: 3,
        passed: 2,
        failed: 1,
        pending: 0,
        skipped: 0,
        neutral: 0,
      },
      runs: [
        {
          name: "lint",
          status: "completed",
          conclusion: "success",
          url: null,
          startedAt: new Date(Date.now() - 200_000).toISOString(),
          completedAt: new Date(Date.now() - 170_000).toISOString(),
          durationMs: 41_000,
          app: null,
        },
        {
          name: "typecheck",
          status: "completed",
          conclusion: "success",
          url: null,
          startedAt: new Date(Date.now() - 200_000).toISOString(),
          completedAt: new Date(Date.now() - 100_000).toISOString(),
          durationMs: 122_000,
          app: "app",
        },
        {
          name: "coverage",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/oxageninc/oxagen-platform/actions/runs/4003",
          startedAt: new Date(Date.now() - 200_000).toISOString(),
          completedAt: new Date(Date.now() - 40_000).toISOString(),
          durationMs: 158_000,
          app: "app",
        },
      ],
    },
  },
};

/** A merged PR with no comments and green CI. */
export const Merged: Story = {
  args: {
    number: 736,
    title: "feat: graph result json snippet",
    url: "https://github.com/oxageninc/oxagen-platform/pull/736",
    state: "merged",
    draft: false,
    author: "macanderson",
    authorAvatarUrl: null,
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    body: "Renders graph query results as a clipped, highlighted JSON snippet.",
    baseRef: "main",
    headRef: "feat/graph-result-json-snippet",
    headSha: "edb06a72a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    additions: 87,
    deletions: 14,
    changedFiles: 4,
    commits: 2,
    commentCount: 0,
    reviewCommentCount: 0,
    comments: [],
    ci: {
      overall: "passing",
      counts: {
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        skipped: 0,
        neutral: 0,
      },
      runs: [
        {
          name: "gate",
          status: "completed",
          conclusion: "success",
          url: null,
          startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          completedAt: new Date(
            Date.now() - 2 * 86_400_000 + 200_000,
          ).toISOString(),
          durationMs: 200_000,
          app: null,
        },
      ],
    },
  },
};
