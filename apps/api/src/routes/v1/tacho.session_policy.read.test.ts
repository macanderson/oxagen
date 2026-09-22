import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { tachoSessionPolicyReadRoute } from "./tacho.session_policy.read";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = {
  mode: "observed",
  sessionLimitUsd: null,
  modelAllow: null,
  modelDeny: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

describe("GET tacho/session-policy", () => {
  it("invokes the capability and returns the policy", async () => {
    const res = await tachoSessionPolicyReadRoute.fetch(
      new Request("http://localhost/"),
    );

    expect(res.status).toBe(200);
    // A null allowlist reaches the caller as null. Serializing it away would
    // make "every model is permitted" indistinguishable from "none is".
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_tacho_session_policy",
      {},
      fakeCtx,
      { surface: "api" },
    );
  });
});
