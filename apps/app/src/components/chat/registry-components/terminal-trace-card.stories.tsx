import type { Meta, StoryObj } from "@storybook/react-vite";
import TerminalTraceCard from "./terminal-trace-card";

const meta = {
  title: "Chat/TerminalTraceCard",
  component: TerminalTraceCard,
} satisfies Meta<typeof TerminalTraceCard>;
export default meta;
type Story = StoryObj<typeof meta>;

const LONG_OUTPUT = Array.from(
  { length: 60 },
  (_, i) => `[${String(i + 1).padStart(2, "0")}] Running task ${i + 1}/60...`,
).join("\n");

export const Success: Story = {
  args: {
    command: "pnpm --filter @oxagen/api build",
    stdout: "Building @oxagen/api...\nBuild completed in 4.2s",
    stderr: "",
    exitCode: 0,
    durationMs: 4200,
  },
};

export const Failure: Story = {
  args: {
    command: "pnpm --filter @oxagen/api test:unit",
    stdout: "Running 42 tests...",
    stderr: "FAIL src/routes/health.test.ts\n  ● expected 200, got 500",
    exitCode: 1,
    durationMs: 1800,
  },
};

export const WithAnsiColor: Story = {
  args: {
    command: "pnpm lint",
    stdout:
      "\x1b[32m✓\x1b[0m 128 files passed\n\x1b[31m✗\x1b[0m 2 files with warnings",
    exitCode: 0,
    durationMs: 900,
  },
};

export const TimedOut: Story = {
  args: {
    command: "pnpm dev",
    stdout: "Starting dev server...",
    exitCode: 124,
    timedOut: true,
    durationMs: 120_000,
  },
};

export const LongScrollbackAutoCollapsed: Story = {
  args: {
    command: "pnpm build",
    stdout: LONG_OUTPUT,
    exitCode: 0,
    durationMs: 32_000,
  },
};
