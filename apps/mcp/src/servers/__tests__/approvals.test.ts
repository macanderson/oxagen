// approvals.test.ts: the key that finds a parked served call's approval
// (lane M15). The Postgres side is not reached here, so its modules are
// replaced, and the digest is plain JSON so the test can read what the key
// covers.
import { describe, expect, it, vi } from "vitest";
import { servedResumeKey } from "../approvals";
import type { ApprovalRequest } from "../types";
import { AGENT, run } from "./fixtures";

vi.mock("@oxagen/database", () => ({ schema: {}, withTenantDb: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: vi.fn() }));
vi.mock("@oxagen/rules/approval-notify", () => ({ notifyApprovalRequested: vi.fn() }));
vi.mock("@oxagen/rules", () => ({ inputDigest: (input: unknown) => JSON.stringify(input) }));

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    run: run(),
    agent: AGENT,
    tool: "billing__create_refund",
    version: 1,
    publication: { repository: "finops-steering", version: 4 },
    server: "billing",
    args: { charge: "ch_1", amount: 100 },
    reasons: ["irreversible.approval"],
    risk: "high",
    ...overrides,
  };
}

describe("servedResumeKey", () => {
  it("covers the run, the machine, the agent, the tool at its version, the publication, and the arguments", () => {
    const key = servedResumeKey(request());
    expect(key.startsWith("served:")).toBe(true);
    expect(JSON.parse(key.slice("served:".length))).toEqual({
      workspaceId: "ws_1",
      machine: "hst_1",
      run: "tse_1",
      agent: AGENT.name,
      tool: "billing__create_refund",
      version: 1,
      publication: { repository: "finops-steering", version: 4 },
      args: { charge: "ch_1", amount: 100 },
    });
  });

  it("finds the same approval for the same call from the same run", () => {
    expect(servedResumeKey(request())).toBe(servedResumeKey(request()));
  });

  it("keeps one run from claiming another run's approval", () => {
    expect(servedResumeKey(request({ run: run({ runPublicId: "tse_2" }) }))).not.toBe(servedResumeKey(request()));
    expect(servedResumeKey(request({ run: run({ machine: "hst_2" }) }))).not.toBe(servedResumeKey(request()));
  });

  it("opens a new approval once a publish changes the tool", () => {
    expect(servedResumeKey(request({ version: 2 }))).not.toBe(servedResumeKey(request()));
  });

  it("opens a new approval after any new publication, even when the tool is unchanged", () => {
    const republished = request({ publication: { repository: "finops-steering", version: 5 } });
    expect(servedResumeKey(republished)).not.toBe(servedResumeKey(request()));
  });
});
