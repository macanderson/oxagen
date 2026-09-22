/**
 * Reading the workspace's wrapped-session policy.
 *
 * Thin by design: the shared reader does the work, and it has its own tests in
 * `lib/tacho-session-policy.test.ts`. What is asserted here is the part only
 * this file owns — that the handler refuses without a workspace before it
 * reads anything, and that it hands the policy back unchanged rather than
 * reshaping it on the way out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ readPolicy: vi.fn() }));

vi.mock("./lib/tacho-session-policy", () => ({
  readTachoSessionPolicy: mocks.readPolicy,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { tachoSessionPolicyReadHandler } from "./tacho.session_policy.read";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get_tacho_session_policy", () => {
  it("returns the workspace's policy as the reader gives it", async () => {
    const policy = {
      mode: "enforced" as const,
      sessionLimitUsd: 25,
      modelAllow: ["claude-opus-*"],
      modelDeny: ["gpt-4o"],
    };
    mocks.readPolicy.mockResolvedValue(policy);

    expect(await tachoSessionPolicyReadHandler({}, TEST_CTX)).toEqual(policy);
    expect(mocks.readPolicy).toHaveBeenCalledWith(TEST_CTX.workspaceId);
  });

  it("keeps a null allowlist null on the way out", async () => {
    // `null` means every model is permitted and `[]` means none is. A handler
    // that normalized one into the other would invert the policy.
    mocks.readPolicy.mockResolvedValue({
      mode: "observed",
      sessionLimitUsd: null,
      modelAllow: null,
      modelDeny: [],
    });

    const out = await tachoSessionPolicyReadHandler({}, TEST_CTX);
    expect(out.modelAllow).toBeNull();
  });

  it("refuses without a workspace before it reads anything", async () => {
    await expect(
      tachoSessionPolicyReadHandler({}, makeCTX({ workspaceId: undefined })),
    ).rejects.toThrow(/workspace context/);
    expect(mocks.readPolicy).not.toHaveBeenCalled();
  });
});
