import { describe, expect, it } from "vitest";
import {
  agentApprovalListResolved,
  resolvedApprovalListItem,
} from "./agent.approval.list_resolved";

const item = {
  id: "apr_0123456789abcdefghjkmn",
  runId: null,
  tool: "create_workspace",
  requester: "usr_0123456789abcdefghjkmn",
  createdAt: "2026-09-13T10:00:00.000Z",
  expiresAt: "2026-09-13T10:05:00.000Z",
  resolvedAt: "2026-09-13T10:00:01.000Z",
  resolution: "approved" as const,
  resolvedBy: "policy:small-vendor-payments",
  autoRuleId: "small-vendor-payments",
  autoEligibility: null,
  mandateId: null,
  chain: { agentKey: null, rule: null },
};

describe("list_resolved_approvals contract", () => {
  it("is a console read: scoped, non-mutating, unmetered, deny by default for Owner/Admin/Member, on cli too", () => {
    expect(agentApprovalListResolved.name).toBe("list_resolved_approvals");
    expect(agentApprovalListResolved.scoped).toBe(true);
    expect(agentApprovalListResolved.mutates).toBe(false);
    expect(agentApprovalListResolved.noBillingGate).toBe(true);
    expect(agentApprovalListResolved.defaultEffect).toBe("deny");
    expect(agentApprovalListResolved.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    expect(agentApprovalListResolved.layers).not.toContain("e2e");
    expect(agentApprovalListResolved.layers).toContain("app");
    expect(agentApprovalListResolved.surfaces).toEqual(["api", "mcp", "cli"]);
  });

  it("defaults the page size, accepts a run filter, a resolved-at range and a cursor, and refuses the rest", () => {
    expect(agentApprovalListResolved.input.parse({})).toEqual({ limit: 50 });
    expect(
      agentApprovalListResolved.input.parse({
        runId: "arun_0123456789abcdefghjkmn",
        since: "2026-09-01T00:00:00.000Z",
        until: "2026-09-18T00:00:00.000Z",
        limit: 5,
        cursor: "c",
      }),
    ).toEqual({
      runId: "arun_0123456789abcdefghjkmn",
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-18T00:00:00.000Z",
      limit: 5,
      cursor: "c",
    });
    expect(
      agentApprovalListResolved.input.safeParse({ limit: 0 }).success,
    ).toBe(false);
    expect(
      agentApprovalListResolved.input.safeParse({ limit: 101 }).success,
    ).toBe(false);
    expect(
      agentApprovalListResolved.input.safeParse({ since: "yesterday" }).success,
    ).toBe(false);
    expect(
      agentApprovalListResolved.input.safeParse({ status: "approved" }).success,
    ).toBe(false);
  });

  it("answers with items and a cursor", () => {
    const out = agentApprovalListResolved.output.parse({
      items: [item],
      nextCursor: "next",
    });
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBe("next");
  });

  it("carries the resolution, who or what resolved it, and the auto-approval rule id on its own", () => {
    const parsed = resolvedApprovalListItem.parse(item);
    expect(parsed.resolution).toBe("approved");
    expect(parsed.resolvedBy).toBe("policy:small-vendor-payments");
    expect(parsed.autoRuleId).toBe("small-vendor-payments");
    expect(
      resolvedApprovalListItem.parse({
        ...item,
        resolution: "denied",
        resolvedBy: "user:usr_0123456789abcdefghjkmn",
        autoRuleId: null,
      }).resolvedBy,
    ).toBe("user:usr_0123456789abcdefghjkmn");
    expect(
      resolvedApprovalListItem.safeParse({ ...item, resolution: "pending" })
        .success,
    ).toBe(false);
    expect(
      resolvedApprovalListItem.safeParse({ ...item, resolvedBy: "somebody" })
        .success,
    ).toBe(false);
  });

  it("refuses a field the record does not carry, and requires resolvedAt", () => {
    expect(
      resolvedApprovalListItem.safeParse({ ...item, status: "done" }).success,
    ).toBe(false);
    const { resolvedAt: _omitted, ...withoutField } = item;
    expect(resolvedApprovalListItem.safeParse(withoutField).success).toBe(
      false,
    );
  });
});
