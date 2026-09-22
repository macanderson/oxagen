import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { tachoSessionPolicyWriteRoute } from "./tacho.session_policy.write";

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
  mode: "enforced",
  sessionLimitUsd: 25,
  modelAllow: ["claude-opus-*"],
  modelDeny: [],
  reach: { hosts: 2, hostsEnforcingModels: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function patch(body: unknown): Promise<Response> {
  return tachoSessionPolicyWriteRoute.fetch(
    new Request("http://localhost/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH tacho/session-policy", () => {
  it("forwards the parsed body to invoke and returns the output", async () => {
    const res = await patch({
      mode: "enforced",
      sessionLimitUsd: 25,
      modelAllow: ["claude-opus-*"],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_tacho_session_policy",
      {
        mode: "enforced",
        sessionLimitUsd: 25,
        modelAllow: ["claude-opus-*"],
      },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("keeps a null allowlist on the wire rather than dropping the key", async () => {
    // `null` drops the allowlist and permits every model; an omitted key
    // leaves it alone. The route must not collapse the two, because the
    // handler's merge reads `"modelAllow" in input`.
    await patch({ modelAllow: null });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_tacho_session_policy",
      { modelAllow: null },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke when the body fails contract validation", async () => {
    const res = await patch({ sessionLimitUsd: -5 });

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke on a model pattern the host could not apply", async () => {
    // A star in the middle reads like a glob and is not one. Refusing at the
    // edge stops a rule that would silently match nothing from being stored.
    const res = await patch({ modelDeny: ["claude-*-5"] });

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
