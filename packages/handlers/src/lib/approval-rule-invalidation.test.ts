import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import type { AutoApprovalRule } from "@oxagen/oxagen/approval-rules/schemas";
import {
  changedRuleMeaning,
  invalidateApprovalRules,
  type ApprovalToolFacts,
} from "./approval-rule-invalidation";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  check: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("../_approval_rule", () => ({
  readRules: mocks.read,
  writeRules: mocks.write,
  assertRulesSavable: mocks.check,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventIn: mocks.emit,
}));
const rule = (overrides: Partial<AutoApprovalRule> = {}): AutoApprovalRule => ({
  id: "refunds",
  name: "Refunds",
  tools: ["pay@*"],
  enabled: true,
  maxMeasures: { amount: "250000000" },
  allowTargets: {},
  standingWindowMs: null,
  businessHours: null,
  createdBy: "usr_author",
  createdAt: "2026-09-19T00:00:00.000Z",
  authoredConsequences: [],
  ...overrides,
});
const facts = (
  overrides: Partial<ApprovalToolFacts> = {},
): ApprovalToolFacts => ({
  slug: "pay",
  version: 1,
  consequenceTags: [],
  classification: null,
  measures: {
    amount: { path: "amount.value", type: "amount", unit: "USD", scale: 2 },
  },
  ...overrides,
});
const tx = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => [{ id: "author-uuid" }] }),
    }),
  }),
} as unknown as Tx;
const args = {
  orgId: "org",
  workspaceId: "workspace",
  actorUserId: "classifier",
  capability: "set_tool_classification",
  before: facts(),
  after: facts({ consequenceTags: ["moves_money"] }),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue([rule()]);
  mocks.check.mockResolvedValue(new Map([["refunds", ["moves_money"]]]));
});

describe("changed rule meaning", () => {
  it.each([
    { path: "fee.value" },
    { type: "count" },
    { unit: "EUR" },
    { scale: 0 },
  ])("requires review when a named measure changes: %j", (change) => {
    const before = facts();
    const after = facts({
      version: 2,
      measures: {
        amount: {
          path: "amount.value",
          type: "amount",
          unit: "USD",
          scale: 2,
          ...change,
        },
      },
    });
    expect(changedRuleMeaning(rule(), before, after)).toBe("measure_changed");
  });
  it("ignores changes to measures the rule does not use", () => {
    expect(
      changedRuleMeaning(
        rule(),
        facts(),
        facts({
          measures: {
            ...(facts().measures as object),
            count: { path: "other", type: "count" },
          },
        }),
      ),
    ).toBeNull();
  });
  it("leaves a rule pinned to the old version untouched", () => {
    expect(
      changedRuleMeaning(
        rule({ tools: ["pay@1"] }),
        facts(),
        facts({ version: 2, measures: {} }),
      ),
    ).toBeNull();
  });
  it("requires review for a new wildcard match even with the same measure declaration", () => {
    expect(changedRuleMeaning(rule(), null, facts())).toBe(
      "tool_scope_changed",
    );
  });
});

describe("transactional invalidation", () => {
  it("rechecks the original author and keeps an authorized rule active", async () => {
    await invalidateApprovalRules(tx, args);
    expect(mocks.check).toHaveBeenCalledWith(
      tx,
      {
        orgId: "org",
        workspaceId: "workspace",
        userId: "author-uuid",
        apiKeyId: null,
      },
      "workspace",
      [rule()],
    );
    expect(mocks.write).toHaveBeenCalledWith(tx, "workspace", [
      expect.objectContaining({
        enabled: true,
        createdBy: "usr_author",
        authoredConsequences: ["moves_money"],
      }),
    ]);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("disables an unauthorized author's rule and writes its event in the same transaction", async () => {
    mocks.check.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    await invalidateApprovalRules(tx, args);
    expect(mocks.write).toHaveBeenCalledWith(tx, "workspace", [
      expect.objectContaining({
        enabled: false,
        createdBy: "usr_author",
        disabledReason: expect.objectContaining({
          code: "classification_changed",
          tool: "pay@1",
        }),
      }),
    ]);
    expect(mocks.emit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: "approval_rule.invalidated",
        actorUserId: "classifier",
        detail: expect.objectContaining({
          ruleId: "refunds",
          tool: "pay@1",
          reason: "classification_changed",
        }),
      }),
    );
  });
  it("does not touch unrelated or disabled rules", async () => {
    mocks.read.mockResolvedValue([
      rule({ tools: ["other"] }),
      rule({ enabled: false }),
    ]);
    await invalidateApprovalRules(tx, args);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("disables a changed path even when the author would pass the kind and role checks", async () => {
    await invalidateApprovalRules(tx, {
      ...args,
      after: facts({
        version: 2,
        measures: {
          amount: { path: "fee.value", type: "amount", unit: "USD", scale: 2 },
        },
      }),
    });
    expect(mocks.write).toHaveBeenCalledWith(tx, "workspace", [
      expect.objectContaining({
        enabled: false,
        disabledReason: expect.objectContaining({ code: "measure_changed" }),
      }),
    ]);
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("does not swallow operational check errors", async () => {
    mocks.check.mockRejectedValue(new Error("database unavailable"));
    await expect(invalidateApprovalRules(tx, args)).rejects.toThrow(
      "database unavailable",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("requires a resolvable author", async () => {
    mocks.read.mockResolvedValue([rule({ createdBy: null })]);
    await invalidateApprovalRules(tx, args);
    expect(mocks.write).toHaveBeenCalledWith(tx, "workspace", [
      expect.objectContaining({ enabled: false }),
    ]);
    expect(mocks.check).not.toHaveBeenCalled();
  });
});

it("a successful reauthorization stamp clears the disabled reason", async () => {
  const { stamp } =
    await vi.importActual<typeof import("../_approval_rule")>(
      "../_approval_rule",
    );
  const before = rule({
    disabledReason: {
      code: "measure_changed",
      tool: "pay@2",
      at: "2026-09-19T00:00:00.000Z",
      detail: "Measure changed",
    },
  });
  expect(
    stamp(before, "usr_reviewer", new Date("2026-09-19T01:00:00.000Z"), []),
  ).toMatchObject({ createdBy: "usr_reviewer", disabledReason: undefined });
});
