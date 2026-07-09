import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlanCard } from "./plan-card";

const meta = {
  title: "Chat/PlanCard",
  component: PlanCard,
} satisfies Meta<typeof PlanCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Proposed multi-step plan awaiting approval, with a rationale and a step dependency. */
export const AwaitingApproval: Story = {
  args: {
    planId: "plan_ship_feature",
    title: "Ship the workspace-preferences capability",
    status: "pending",
    rationale:
      "The read/write handlers already exist; the plan wires them through the API route and MCP tool, then adds coverage before opening the PR.",
    steps: [
      {
        id: "s1",
        summary: "Add the API route",
        intent: "Mount GET/PUT /v1/user/workspace-preferences on the Hono app.",
        capability: "user.workspace_preferences.write",
        dependsOn: [],
      },
      {
        id: "s2",
        summary: "Add the MCP tool",
        intent: "Expose the same capability at apps/mcp/src/tools.",
        capability: "user.workspace_preferences.read",
        dependsOn: ["s1"],
      },
      {
        id: "s3",
        summary: "Write unit tests",
        intent: "Cover both handlers to the package coverage threshold.",
        capability: null,
        dependsOn: ["s1", "s2"],
      },
    ],
    agentCapabilities: [
      {
        name: "user.workspace_preferences.write",
        description: "Persist a user's per-workspace preferences.",
        riskLevel: "medium",
      },
      {
        name: "user.workspace_preferences.read",
        description: "Read a user's per-workspace preferences.",
        riskLevel: "low",
      },
    ],
    onResolve: async () => ({ ok: true }),
  },
};

/** A minimal single-step plan with no rationale. */
export const SingleStep: Story = {
  args: {
    planId: "plan_rename",
    title: "Rename the deprecated capability alias",
    status: "pending",
    steps: [
      {
        id: "s1",
        summary: "Update the contract name",
        intent: "Point the alias at the canonical snake_case identifier.",
        capability: "schema.label.upsert",
        dependsOn: [],
      },
    ],
    onResolve: async () => ({ ok: true }),
  },
};

/** An already-approved plan — settled, no action buttons. */
export const Approved: Story = {
  args: {
    planId: "plan_done",
    title: "Backfill node embeddings",
    status: "approved",
    steps: [
      {
        id: "s1",
        summary: "Dispatch the backfill job",
        intent: "Kick off graph.embed.backfill for the workspace.",
        capability: "graph.embed.backfill",
        dependsOn: [],
      },
      {
        id: "s2",
        summary: "Verify embedding coverage",
        intent: "Query node count vs embedded count after the job.",
        capability: null,
        dependsOn: ["s1"],
      },
    ],
  },
};
