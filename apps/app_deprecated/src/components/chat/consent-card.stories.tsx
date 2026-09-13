import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConsentCard } from "./consent-card";

const meta = {
  title: "Chat/ConsentCard",
  component: ConsentCard,
} satisfies Meta<typeof ConsentCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** First-use consent for an external MCP tool — grant/deny plus the "trust every tool" opt-in. */
export const Pending: Story = {
  args: {
    approvalId: "cns_linear_01",
    capability: "mcp.linear.create_issue",
    serverId: "linear",
    toolName: "create_issue",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    inputPreview: {
      team: "oxagen-v2",
      title: "Wire graph-stats card into chat registry",
      priority: 2,
    },
    onResolved: async () => ({ ok: true }),
  },
};

/** Consent granted — settled success badge for a tool the user now trusts. */
export const Granted: Story = {
  args: {
    approvalId: "cns_github_02",
    capability: "mcp.github.open_pull_request",
    serverId: "github",
    toolName: "open_pull_request",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    resolution: "granted",
    inputPreview: { owner: "oxageninc", repo: "oxagen-platform", base: "main" },
  },
};

/** Consent denied — the agent may not call this external tool. */
export const Denied: Story = {
  args: {
    approvalId: "cns_notion_03",
    capability: "mcp.notion.delete_page",
    serverId: "notion",
    toolName: "delete_page",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    resolution: "denied",
    inputPreview: { pageId: "pg_9f2ka91xq3" },
  },
};
