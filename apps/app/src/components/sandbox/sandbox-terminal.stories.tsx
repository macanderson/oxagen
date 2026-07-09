import type { Meta, StoryObj } from "@storybook/react-vite";
import { SandboxTerminal, type SandboxExecResult } from "./sandbox-terminal";

/**
 * A mock runner so the terminal is fully interactive in Storybook without a
 * live sandbox: it canned-responds to a few commands and echoes the rest.
 */
function mockRunner(delayMs = 350) {
  return async (command: string): Promise<SandboxExecResult> => {
    await new Promise((r) => setTimeout(r, delayMs));
    if (command.startsWith("ls")) {
      return {
        stdout: "README.md\nsrc\ndocs\n.oxagen\npackage.json",
        stderr: "",
        exitCode: 0,
        executionMs: 42,
        timedOut: false,
        restored: false,
      };
    }
    if (command.startsWith("git status")) {
      return {
        stdout:
          "\x1b[32mOn branch main\x1b[0m\nnothing to commit, working tree clean",
        stderr: "",
        exitCode: 0,
        executionMs: 88,
        timedOut: false,
        restored: false,
      };
    }
    if (command.startsWith("cat missing")) {
      return {
        stdout: "",
        stderr: "\x1b[31mcat: missing: No such file or directory\x1b[0m",
        exitCode: 1,
        executionMs: 12,
        timedOut: false,
        restored: false,
      };
    }
    return {
      stdout: command,
      stderr: "",
      exitCode: 0,
      executionMs: 20,
      timedOut: false,
      restored: false,
    };
  };
}

const meta = {
  title: "Sandbox/SandboxTerminal",
  component: SandboxTerminal,
} satisfies Meta<typeof SandboxTerminal>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Fresh terminal — type `ls`, `git status`, or anything to see it respond. */
export const Empty: Story = {
  args: {
    sessionId: "sbx_9f2c1a4b8d6e",
    runCommand: mockRunner(),
    welcome: "Warm workspace ready. Connected to sbx_9f2c1a4b8d6e (agent image).",
  },
};

/** Pre-seeded scrollback showing a successful run and an ANSI-coloured error. */
export const WithHistory: Story = {
  args: {
    sessionId: "sbx_9f2c1a4b8d6e",
    runCommand: mockRunner(),
    initialHistory: [
      {
        command: "ls -la",
        status: "done",
        stdout: "total 8\ndrwxr-xr-x  README.md\ndrwxr-xr-x  src\n-rw-r--r--  package.json",
        stderr: "",
        exitCode: 0,
        executionMs: 41,
        timedOut: false,
      },
      {
        command: "cat missing.txt",
        status: "error",
        stdout: "",
        stderr: "\x1b[31mcat: missing.txt: No such file or directory\x1b[0m",
        exitCode: 1,
        executionMs: 9,
        timedOut: false,
      },
    ],
  },
};

/** Read-only state — the session is stopped, so the input is disabled. */
export const Disabled: Story = {
  args: {
    sessionId: "sbx_9f2c1a4b8d6e",
    runCommand: mockRunner(),
    disabled: true,
    initialHistory: [
      {
        command: "echo done",
        status: "done",
        stdout: "done",
        stderr: "",
        exitCode: 0,
        executionMs: 5,
        timedOut: false,
      },
    ],
  },
};
