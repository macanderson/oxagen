import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { promptSettingsWriteRoute } from "./prompt.settings.write";

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
  additionalInstructions: "Be terse.",
  overrides: null,
  autoImprovePrompts: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function patch(body: unknown): Promise<Response> {
  return promptSettingsWriteRoute.fetch(
    new Request("http://localhost/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH prompt/settings", () => {
  it("forwards the parsed body to invoke and returns the output", async () => {
    const res = await patch({ additionalInstructions: "Be terse." });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_prompt_settings",
      { additionalInstructions: "Be terse." },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke when the body fails contract validation", async () => {
    const res = await patch({ autoImprovePrompts: "not-a-boolean" });

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
