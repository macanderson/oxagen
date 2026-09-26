import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { tachoWorkspaceRunsPauseRoute } from "./tacho.workspace_runs.pause";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = {
  queued: 1,
  commandIds: ["tcm_1"],
  skipped: [
    {
      runId: "tse_0123456789abcdefghjkmn",
      agentKey: "acme.core.cc-laptop",
      reason: "host_offline",
      commandId: "tcm_2",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function post(body: string): Promise<Response> {
  return tachoWorkspaceRunsPauseRoute.fetch(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

describe("POST commands/pause-workspace", () => {
  it("invokes pause_workspace_runs on the api surface and answers the receipt with 201", async () => {
    const res = await post(JSON.stringify({ reason: "Incident 42" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "pause_workspace_runs",
      { reason: "Incident 42" },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke without a reason (negative)", async () => {
    const res = await post(JSON.stringify({}));

    expect(res.status).not.toBe(201);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke when the body names a workspace, since the scope is the URL's (negative)", async () => {
    const res = await post(
      JSON.stringify({ reason: "Incident 42", workspaceId: "other" }),
    );

    expect(res.status).not.toBe(201);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON (negative)", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
