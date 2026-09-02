import type { Meta, StoryObj } from "@storybook/react-vite";
import CiStatusCard from "./ci-status-card";

const meta = {
  title: "Chat/CiStatusCard",
  component: CiStatusCard,
} satisfies Meta<typeof CiStatusCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** All checks green for a branch ref — the passing roll-up. */
export const Passing: Story = {
  args: {
    ref: "feat/sandbox-detail-terminal-stories",
    sha: "91e9a8ba5c1d4e2f8a7b9c0d1e2f3a4b5c6d7e8f",
    overall: "passing",
    counts: {
      total: 3,
      passed: 3,
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
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/1001",
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        completedAt: new Date(Date.now() - 240_000).toISOString(),
        durationMs: 58_000,
        app: "app",
      },
      {
        name: "typecheck",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/1002",
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        completedAt: new Date(Date.now() - 180_000).toISOString(),
        durationMs: 132_000,
        app: "api",
      },
      {
        name: "unit tests",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/1003",
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        completedAt: new Date(Date.now() - 120_000).toISOString(),
        durationMs: 96_400,
        app: null,
      },
    ],
  },
};

/** A failing ref — one check red, one still running. */
export const Failing: Story = {
  args: {
    ref: "fix/rls-fail-open",
    sha: "2cc5db2f9a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    overall: "failing",
    counts: {
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1,
      skipped: 0,
      neutral: 0,
    },
    runs: [
      {
        name: "lint",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/2001",
        startedAt: new Date(Date.now() - 200_000).toISOString(),
        completedAt: new Date(Date.now() - 150_000).toISOString(),
        durationMs: 47_000,
        app: null,
      },
      {
        name: "coverage",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/oxageninc/oxagen-platform/actions/runs/2002",
        startedAt: new Date(Date.now() - 200_000).toISOString(),
        completedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 141_000,
        app: "app",
      },
      {
        name: "e2e",
        status: "in_progress",
        conclusion: null,
        url: null,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        completedAt: null,
        durationMs: null,
        app: "app",
      },
    ],
  },
};

/** No CI checks reported for the ref — the empty state. */
export const NoChecks: Story = {
  args: {
    ref: "chore/docs-only",
    sha: null,
    overall: "unknown",
    counts: {
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      neutral: 0,
    },
    runs: [],
  },
};
