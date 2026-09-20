import { expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: (fn: (tx: unknown) => unknown) =>
    fn({ query: { approvalRequests: { findMany } } }),
}));
import { agentApprovalListResolvedHandler } from "./agent.approval.list_resolved";

it.each(["succeeded", "failed", "indeterminate"])(
  "selects and returns %s execution evidence through the relational projection",
  async (status) => {
    findMany.mockImplementation(async ({ columns }) => {
      expect(columns).toMatchObject({
        resumeStatus: true,
        resumeRunPublicId: true,
        resumeError: true,
      });
      const stored = {
        publicId: "apr_test",
        capabilityName: "write_test",
        createdAt: new Date(0),
        expiresAt: new Date(60000),
        resolvedAt: new Date(1000),
        resolution: "approved",
        resolvedByPolicy: null,
        runPublicId: "arun_original",
        ruleIds: [],
        autoRuleId: null,
        resolvedReasons: [],
        resumeStatus: status,
        resumeRunPublicId: "arun_resumed",
        resumeError: status === "succeeded" ? null : "kill_switch_active",
      };
      return [
        Object.fromEntries(
          Object.entries(stored).filter(([key]) => columns[key]),
        ),
      ];
    });
    const out = await agentApprovalListResolvedHandler(
      { limit: 10 },
      {
        orgId: "org",
        workspaceId: "ws",
        userId: "user",
        apiKeyId: null,
        requestId: "request",
        surface: "app",
        messageId: null,
      },
    );
    expect(out.items[0]?.execution).toEqual({
      status,
      runId: "arun_resumed",
      reason: status === "succeeded" ? null : "kill_switch_active",
    });
  },
);
