import type { Meta, StoryObj } from "@storybook/react-vite";
import CodingTracePanel from "./coding-trace-panel";

const meta = {
  title: "Chat/CodingTracePanel",
  component: CodingTracePanel,
} satisfies Meta<typeof CodingTracePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const SAMPLE_PATCH = [
  "@@ -12,6 +12,7 @@ export function greet(name: string) {",
  "   if (!name) {",
  "     throw new Error('name is required');",
  "   }",
  "-  return `Hi ${name}`;",
  "+  return `Hello, ${name}!`;",
  " }",
].join("\n");

export const TerminalAndDiff: Story = {
  args: {
    title: "Fix greeting bug",
    steps: [
      {
        kind: "terminal",
        title: "Run tests",
        status: "success",
        durationMs: 4200,
        terminal: {
          command: "pnpm exec vitest run src/lib/greet.test.ts",
          stdout: "✓ greet.test.ts (1 test)\n\nTest Files  1 passed (1)",
          exitCode: 0,
          durationMs: 4200,
        },
      },
      {
        kind: "diff",
        title: "Apply patch",
        status: "success",
        durationMs: 850,
        diff: {
          files: [{ path: "src/lib/greet.ts", patch: SAMPLE_PATCH }],
          summary: "Improved the greeting message.",
        },
      },
    ],
  },
};

export const WithFailedStep: Story = {
  args: {
    title: "Investigate failing build",
    steps: [
      {
        kind: "terminal",
        title: "Run build",
        status: "error",
        durationMs: 1800,
        terminal: {
          command: "pnpm build",
          stdout: "",
          stderr: "Error: Cannot find module './missing'",
          exitCode: 1,
          durationMs: 1800,
        },
      },
    ],
  },
};

export const RunningStep: Story = {
  args: {
    title: "Refactor in progress",
    steps: [
      {
        kind: "terminal",
        title: "Run lint",
        status: "running",
        terminal: {
          command: "pnpm exec eslint .",
          stdout: "",
        },
      },
    ],
  },
};

export const Empty: Story = {
  args: { steps: [] },
};
