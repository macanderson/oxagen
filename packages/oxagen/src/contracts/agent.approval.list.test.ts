import { describe, expect, it } from "vitest";
import { agentApprovalList, approvalListItem } from "./agent.approval.list";
import { agentApprovalResolve } from "./agent.approval.resolve";

const item = {
  id: "apr_0123456789abcdefghjkmn",
  runId: null,
  tool: "create_workspace",
  requester: "usr_0123456789abcdefghjkmn",
  createdAt: "2026-09-13T10:00:00.000Z",
  expiresAt: "2026-09-13T10:05:00.000Z",
  mandateId: null,
  autoEligibility: null,
  chain: { agentKey: null, rule: null },
};

describe("list_approvals contract", () => {
  it("is a console read: scoped, non-mutating, unmetered, deny by default for Owner/Admin/Member", () => {
    expect(agentApprovalList.name).toBe("list_approvals");
    expect(agentApprovalList.scoped).toBe(true);
    expect(agentApprovalList.mutates).toBe(false);
    expect(agentApprovalList.noBillingGate).toBe(true);
    expect(agentApprovalList.defaultEffect).toBe("deny");
    expect(agentApprovalList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    expect(agentApprovalList.layers).not.toContain("e2e");
    expect(agentApprovalList.surfaces).toEqual(["api", "mcp"]);
  });

  it("keeps resolve_approval as the governed action it pairs with", () => {
    expect("noBillingGate" in agentApprovalResolve).toBe(false);
  });

  it("defaults the page size, accepts a run filter and a cursor, and refuses the rest", () => {
    expect(agentApprovalList.input.parse({})).toEqual({ limit: 50 });
    expect(
      agentApprovalList.input.parse({
        runId: "arun_0123456789abcdefghjkmn",
        limit: 5,
        cursor: "c",
      }),
    ).toEqual({ runId: "arun_0123456789abcdefghjkmn", limit: 5, cursor: "c" });
    expect(agentApprovalList.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(agentApprovalList.input.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(agentApprovalList.input.safeParse({ runId: "" }).success).toBe(
      false,
    );
    expect(
      agentApprovalList.input.safeParse({ status: "pending" }).success,
    ).toBe(false);
  });

  it("answers with items, a cursor and the whole queue's count", () => {
    const out = agentApprovalList.output.parse({
      items: [item],
      nextCursor: "next",
      total: 140,
    });
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBe("next");
    expect(out.total).toBe(140);
    expect(
      agentApprovalList.output.parse({ items: [], nextCursor: null, total: 0 })
        .nextCursor,
    ).toBeNull();
  });

  // #3521: a reader shows one page and the count beside it, so the count is
  // required rather than something a caller has to walk the cursor to learn.
  it("refuses a page without a count, or with a count that is not a whole number", () => {
    for (const total of [undefined, -1, 1.5, "140"]) {
      expect(
        agentApprovalList.output.safeParse({
          items: [],
          nextCursor: null,
          total,
        }).success,
      ).toBe(false);
    }
  });

  it("carries public ids only", () => {
    expect(
      approvalListItem.safeParse({
        ...item,
        id: "0195b7c8-1e6e-7c3a-9f0e-0a1b2c3d4e5f",
      }).success,
    ).toBe(false);
    expect(Object.keys(approvalListItem.shape).sort()).toEqual([
      "autoEligibility",
      "chain",
      "createdAt",
      "expiresAt",
      "id",
      "mandateId",
      "requester",
      "runId",
      "tool",
    ]);
    expect(Object.keys(approvalListItem.shape.chain.shape).sort()).toEqual([
      "agentKey",
      "rule",
    ]);
  });

  it("holds a recorded run, requester and chain, and refuses a field the record does not carry", () => {
    const recorded = approvalListItem.parse({
      ...item,
      runId: "arun_0123456789abcdefghjkmn",
      chain: { agentKey: "acme.core.release-manager", rule: "rg_0093" },
    });
    expect(recorded.runId).toBe("arun_0123456789abcdefghjkmn");
    expect(recorded.chain.agentKey).toBe("acme.core.release-manager");
    expect(
      approvalListItem.parse({
        ...item,
        mandateId: "mnd_0123456789abcdefghjkmn",
        chain: {
          agentKey: null,
          rule: "mandate:mnd_0123456789abcdefghjkmn:human_above:amount",
        },
      }).mandateId,
    ).toBe("mnd_0123456789abcdefghjkmn");
    expect(approvalListItem.safeParse({ ...item, risk: "high" }).success).toBe(
      false,
    );
    expect(approvalListItem.safeParse({ ...item, tool: "" }).success).toBe(
      false,
    );
    expect(
      approvalListItem.safeParse({ ...item, createdAt: "yesterday" }).success,
    ).toBe(false);
  });

  it("carries the eligibility line the evaluation recorded, and null when no rule covered the call", () => {
    // The row is the record of what the rule said when the call was parked
    // (ADR-070): the app prints it rather than re-judging a stale call.
    const judged = approvalListItem.parse({
      ...item,
      autoEligibility: {
        ruleId: "spend.under-100",
        ok: false,
        reasons: ["measure_above_ceiling:amount", "critical_hazard"],
        floor: true,
      },
    });
    expect(judged.autoEligibility).toEqual({
      ruleId: "spend.under-100",
      ok: false,
      reasons: ["measure_above_ceiling:amount", "critical_hazard"],
      floor: true,
    });
    // A mandate outranks a workspace rule, so `ok: true` and a parked row
    // coexist (spec §6.9 part 3).
    expect(
      approvalListItem.parse({
        ...item,
        mandateId: "mnd_0123456789abcdefghjkmn",
        autoEligibility: {
          ruleId: "spend.under-100",
          ok: true,
          reasons: [],
          floor: false,
        },
      }).autoEligibility?.ok,
    ).toBe(true);
    // No rule covered the call.
    expect(approvalListItem.parse(item).autoEligibility).toBeNull();
    // The field is required, and the eligibility line is strict.
    const { autoEligibility: _omitted, ...withoutField } = item;
    expect(approvalListItem.safeParse(withoutField).success).toBe(false);
    expect(
      approvalListItem.safeParse({
        ...item,
        autoEligibility: {
          ruleId: "spend.under-100",
          ok: true,
          reasons: [],
          floor: false,
          verdict: "allow",
        },
      }).success,
    ).toBe(false);
  });
});
