import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalCard } from "./approval-card";

const meta = {
  title: "Chat/ApprovalCard",
  component: ApprovalCard,
} satisfies Meta<typeof ApprovalCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** High-risk destructive action still awaiting the user's approve/deny, with a live countdown. */
export const PendingHighRisk: Story = {
  args: {
    approvalId: "apr_7fk2n9",
    capability: "repo.pr.merge",
    riskLevel: "high",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    inputPreview: {
      owner: "oxageninc",
      repo: "oxagen-platform",
      pullNumber: 742,
      mergeMethod: "squash",
    },
    onResolved: async () => ({ ok: true }),
  },
};

/** Medium-risk action that the user has already approved — renders the settled success badge. */
export const Approved: Story = {
  args: {
    approvalId: "apr_send_msg",
    capability: "connection.update",
    riskLevel: "medium",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    resolution: "approved",
    inputPreview: { connectionId: "conn_slack_01", enabled: true },
  },
};

/** Denied action — the terminal denied badge with no action buttons. */
export const Denied: Story = {
  args: {
    approvalId: "apr_delete_wf",
    capability: "workflow.cancel",
    riskLevel: "high",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    resolution: "denied",
    inputPreview: { workflowRunId: "wfr_a91xq3", reason: "manual abort" },
  },
};

/** Expired approval — the deadline passed before the user acted. */
export const Expired: Story = {
  args: {
    approvalId: "apr_expired",
    capability: "billing.grant.create",
    riskLevel: "medium",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    inputPreview: { orgId: "org_acme", credits: 5000 },
    onResolved: async () => ({ ok: true }),
  },
};
