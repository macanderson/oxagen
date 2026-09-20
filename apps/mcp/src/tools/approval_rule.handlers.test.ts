// approval_rule.handlers.test.ts — the five auto-approval tools (ADR-070).
//
// Same pattern as the other tool suites: the kernel `invoke` and the context
// seam are mocked, and each tool is asserted to carry the contract's schema
// and name, to dispatch on the registered capability name with `surface: "mcp"`,
// and to parse its output through the contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

import handler_list, {
  schema as listSchema,
  metadata as listMetadata,
} from "./approval_rule.list";
import handler_set, {
  schema as setSchema,
  metadata as setMetadata,
} from "./approval_rule.set";
import handler_delete, {
  schema as deleteSchema,
  metadata as deleteMetadata,
} from "./approval_rule.delete";
import handler_enabled, {
  schema as enabledSchema,
  metadata as enabledMetadata,
} from "./approval_rule.enabled.set";
import handler_eligibility, {
  schema as eligibilitySchema,
  metadata as eligibilityMetadata,
} from "./approval.auto_eligibility.get";

const RULE = {
  id: "small-vendor-payments",
  name: "Small vendor payments",
  tools: ["stripe__create_payment@*"],
  enabled: true,
  maxMeasures: { amount: "250000000" },
  allowTargets: {},
  standingWindowMs: null,
  businessHours: null,
  createdBy: "usr_0123456789abcdefghjkmn",
  createdAt: "2026-09-02T00:00:00.000Z",
  hits30d: 41,
  skipped30d: 6,
};
const RULE_PAGE = { items: [RULE], windowDays: 30 };

describe("the auto-approval rule tools", () => {
  it("name the capability they dispatch and declare what they do to the workspace", () => {
    expect(listMetadata.name).toBe("list_approval_rules");
    expect(listMetadata.annotations?.readOnlyHint).toBe(true);
    expect(setMetadata.name).toBe("set_approval_rules");
    expect(setMetadata.annotations?.readOnlyHint).toBe(false);
    expect(deleteMetadata.name).toBe("delete_approval_rule");
    expect(deleteMetadata.annotations?.destructiveHint).toBe(true);
    expect(enabledMetadata.name).toBe("set_approval_rule_enabled");
    expect(eligibilityMetadata.name).toBe("get_auto_eligibility");
    expect(eligibilityMetadata.annotations?.readOnlyHint).toBe(true);
  });

  it("carry the contract's own argument schema", () => {
    expect(Object.keys(listSchema)).toEqual([]);
    expect(Object.keys(setSchema).sort()).toEqual([
      "replaces",
      "rules",
      "saving",
    ]);
    expect(Object.keys(deleteSchema)).toEqual(["ruleId"]);
    expect(Object.keys(enabledSchema).sort()).toEqual(["enabled", "ruleId"]);
    expect(Object.keys(eligibilitySchema)).toEqual(["approvalId"]);
  });

  it("dispatch each capability on the mcp surface and parse the page back", async () => {
    for (const [handler, capability, args] of [
      [handler_list, "list_approval_rules", {}],
      [handler_set, "set_approval_rules", { rules: [] }],
      [handler_delete, "delete_approval_rule", { ruleId: RULE.id }],
      [
        handler_enabled,
        "set_approval_rule_enabled",
        { ruleId: RULE.id, enabled: false },
      ],
    ] as const) {
      mocks.invoke.mockResolvedValue(RULE_PAGE);
      const result = await (handler as (a: unknown) => Promise<unknown>)(args);
      expect(mocks.invoke).toHaveBeenLastCalledWith(capability, args, fakeCtx, {
        surface: "mcp",
      });
      expect(result).toEqual(RULE_PAGE);
    }
    expect(mocks.buildContext).toHaveBeenCalledTimes(4);
  });

  it("returns the recorded evaluation and the approver", async () => {
    const out = {
      approvalId: "apr_0123456789abcdefghjkmn",
      resolvedBy: "policy:small-vendor-payments",
      eligibility: {
        ruleId: "small-vendor-payments",
        ok: true,
        reasons: [],
        floor: false,
      },
    };
    mocks.invoke.mockResolvedValue(out);
    expect(
      await handler_eligibility({ approvalId: "apr_0123456789abcdefghjkmn" }),
    ).toEqual(out);
  });

  it("refuses an output whose approver is neither a person nor a rule", async () => {
    mocks.invoke.mockResolvedValue({
      approvalId: "apr_0123456789abcdefghjkmn",
      resolvedBy: "someone",
      eligibility: null,
    });
    await expect(
      handler_eligibility({ approvalId: "apr_0123456789abcdefghjkmn" }),
    ).rejects.toThrow();
  });
});
