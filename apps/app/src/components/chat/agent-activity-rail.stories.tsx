import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentActivityRail } from "./agent-activity-rail";
import type { LiveToolCall } from "./use-tool-stream";

// Render each story at the real desktop rail width so the cards lay out as they
// do in the chat shell's `<aside className="w-72">`.
// Annotate `meta` explicitly rather than using `satisfies`: the decorator's
// inferred type otherwise references `PartialStoryFn` from a deep .pnpm path
// that tsc cannot name in the emitted declaration (TS2883). An explicit
// `Meta<typeof AgentActivityRail>` keeps the type nameable and portable.
const meta: Meta<typeof AgentActivityRail> = {
  title: "Chat/AgentActivityRail",
  component: AgentActivityRail,
  decorators: [
    (Story) => (
      <div style={{ width: 300, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof AgentActivityRail>;

function tc(
  over: Partial<LiveToolCall> & Pick<LiveToolCall, "toolCallId" | "capability">,
): LiveToolCall {
  return {
    messageId: "m1",
    inputPreview: null,
    riskLevel: "low",
    status: "completed",
    stdout: "",
    stderr: "",
    startedAt: 0,
    ...over,
  };
}

/**
 * A code agent bound to a repo, mid-task: Progress shows completed stages,
 * Context shows the repo/branch/env grounding + the open PR, Outputs lists the
 * conversation's files.
 */
export const CodeBound: Story = {
  args: {
    order: ["plan:p1", "tool:a", "tool:b", "tool:c"],
    plans: {
      p1: {
        planId: "p1",
        title: "Add the activity rail",
        steps: [],
        status: "approved",
      },
    },
    toolCalls: {
      a: tc({ toolCallId: "a", capability: "read_file" }),
      b: tc({ toolCallId: "b", capability: "edit_repo_file" }),
      c: tc({ toolCallId: "c", capability: "get_ci_status" }),
    },
    activeFanouts: {},
    turnUsage: { promptTokens: 1840, completionTokens: 420, totalTokens: 2260 },
    isStreaming: false,
    conversationPublicId: "conv_demo",
    orgSlug: "acme",
    workspaceSlug: "eng",
    codeSessionPr: {
      owner: "oxagen",
      name: "platform",
      number: 959,
      url: "https://github.com/oxageninc/oxagen-platform/pull/959",
      headRef: "feat/code-mode-activity-rail",
    },
    availableRepos: [],
    availableEnvironments: [],
    conversationCodeBinding: {
      version: 1,
      agentId: "agt_code",
      connectionId: "con_1",
      owner: "oxagen",
      name: "platform",
      defaultBranch: "main",
      environmentId: "env_1",
      environmentName: "Node 24 · pnpm",
    },
  },
};

/** Streaming: the Progress card shows a live "Working" status while the turn runs. */
export const Streaming: Story = {
  args: {
    ...CodeBound.args,
    isStreaming: true,
    turnUsage: undefined,
    toolCalls: {
      a: tc({ toolCallId: "a", capability: "read_file" }),
      b: tc({
        toolCallId: "b",
        capability: "edit_repo_file",
        status: "running",
      }),
    },
    order: ["plan:p1", "tool:a", "tool:b"],
  },
};

/** Fresh conversation, no code agent: the rail is still present with calm ambient states. */
export const Empty: Story = {
  args: {
    order: [],
    plans: {},
    toolCalls: {},
    activeFanouts: {},
    turnUsage: undefined,
    isStreaming: false,
    conversationPublicId: "conv_empty",
    orgSlug: "acme",
    workspaceSlug: "eng",
    codeSessionPr: null,
    availableRepos: [],
    availableEnvironments: [],
    conversationCodeBinding: null,
  },
};
