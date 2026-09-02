import type { Meta, StoryObj } from "@storybook/react-vite";
import { CiStatusSummary } from "./ci-status-summary";

const meta = {
  title: "Chat/CiStatusSummary",
  component: CiStatusSummary,
} satisfies Meta<typeof CiStatusSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The passing roll-up shared by the ci-status and pr-stats cards. */
export const Passing: Story = {
  args: {
    overall: "passing",
    counts: {
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      skipped: 0,
      neutral: 0,
    },
    runs: [
      {
        name: "lint",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/3001",
        startedAt: new Date(Date.now() - 180_000).toISOString(),
        completedAt: new Date(Date.now() - 150_000).toISOString(),
        durationMs: 32_000,
        app: null,
      },
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/3002",
        startedAt: new Date(Date.now() - 180_000).toISOString(),
        completedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 118_000,
        app: "app",
      },
    ],
  },
};

/** A failing roll-up — a red check alongside a skipped one. */
export const Failing: Story = {
  args: {
    overall: "failing",
    counts: {
      total: 3,
      passed: 1,
      failed: 1,
      pending: 0,
      skipped: 1,
      neutral: 0,
    },
    runs: [
      {
        name: "unit tests",
        status: "completed",
        conclusion: "success",
        url: null,
        startedAt: new Date(Date.now() - 240_000).toISOString(),
        completedAt: new Date(Date.now() - 200_000).toISOString(),
        durationMs: 88_000,
        app: null,
      },
      {
        name: "coverage",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/3102",
        startedAt: new Date(Date.now() - 240_000).toISOString(),
        completedAt: new Date(Date.now() - 90_000).toISOString(),
        durationMs: 150_000,
        app: "billing",
      },
      {
        name: "e2e",
        status: "completed",
        conclusion: "skipped",
        url: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        app: "app",
      },
    ],
  },
};

/** A pending roll-up — checks still queued/in-progress. */
export const Pending: Story = {
  args: {
    overall: "pending",
    counts: {
      total: 2,
      passed: 0,
      failed: 0,
      pending: 2,
      skipped: 0,
      neutral: 0,
    },
    runs: [
      {
        name: "typecheck",
        status: "in_progress",
        conclusion: null,
        url: null,
        startedAt: new Date(Date.now() - 30_000).toISOString(),
        completedAt: null,
        durationMs: null,
        app: "api",
      },
      {
        name: "unit tests",
        status: "queued",
        conclusion: null,
        url: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        app: null,
      },
    ],
  },
};
