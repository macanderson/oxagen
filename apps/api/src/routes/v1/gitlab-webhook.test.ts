// The route is a thin adapter over `handleGitLabWebhook`: it forwards the
// connection id, the `X-Gitlab-Token` header and the parsed body, and answers
// the handler's status and outcome. It also binds the steering repo health
// request (S2, #4560) to the scope lookup and the event client.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSignal } from "@oxagen/handlers/steering-repo/health";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  deps: { marker: "deps" },
  findHealthScopes: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@oxagen/handlers/gitlab.webhook", () => ({
  handleGitLabWebhook: mocks.handle,
  gitlabWebhookDeps: () => mocks.deps,
}));

vi.mock("@oxagen/handlers/steering-repo/health", () => ({
  findHealthScopes: mocks.findHealthScopes,
  healthRequests: (
    scopes: { orgId: string; workspaceId: string | null }[],
    trigger: unknown,
  ) =>
    scopes.map((scope) => ({
      name: "steering-repo/health.requested",
      data: {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        key: `${scope.orgId}:${scope.workspaceId ?? "org"}`,
        trigger,
      },
    })),
}));

vi.mock("../../event-client", () => ({
  eventClient: { send: mocks.send },
}));

const { gitlabWebhookRoute } = await import("./gitlab-webhook");
const app = new Hono().route("/webhooks/gitlab", gitlabWebhookRoute);

const post = (body: string, headers: Record<string, string> = {}) =>
  app.request("/webhooks/gitlab/con_gl1", { method: "POST", body, headers });

describe("POST /webhooks/gitlab/:connectionId", () => {
  beforeEach(() => mocks.handle.mockReset());

  it("forwards the connection, the token header and the parsed body", async () => {
    mocks.handle.mockResolvedValue({
      status: 200,
      outcome: "proposal_rejected",
    });
    const res = await post('{"object_kind":"merge_request"}', {
      "X-Gitlab-Token": "whsec",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "proposal_rejected" });
    expect(mocks.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mocks.deps,
        requestHealthCheck: expect.any(Function),
      }),
      {
        connectionPublicId: "con_gl1",
        tokenHeader: "whsec",
        body: { object_kind: "merge_request" },
      },
    );
  });

  it("passes a missing header as null and answers the handler's 401", async () => {
    mocks.handle.mockResolvedValue({ status: 401, outcome: "unauthenticated" });
    const res = await post("{}");
    expect(res.status).toBe(401);
    expect(mocks.handle.mock.calls[0]?.[1]).toMatchObject({
      tokenHeader: null,
    });
  });

  it("hands an unparseable body to the handler as null", async () => {
    mocks.handle.mockResolvedValue({
      status: 202,
      outcome: "ignored_unparseable",
    });
    const res = await post("not json", { "X-Gitlab-Token": "whsec" });
    expect(res.status).toBe(202);
    expect(mocks.handle.mock.calls[0]?.[1]).toMatchObject({ body: null });
  });
});

describe("POST /webhooks/gitlab/:connectionId: the steering repo health request", () => {
  const SIGNAL: HealthSignal = {
    provider: "gitlab",
    repository_ids: [4242],
    installation_id: null,
    trigger: {
      reason: "push",
      actor: "dana-ops",
      at: "2026-09-26T16:12:44.000Z",
      settings: [],
      pull_request: null,
    },
  };

  beforeEach(() => {
    mocks.handle.mockReset();
    mocks.findHealthScopes.mockReset();
    mocks.send.mockReset();
    mocks.handle.mockResolvedValue({ status: 202, outcome: "ignored_event" });
  });

  /** The requestHealthCheck the route handed the handler. */
  async function boundRequest() {
    await post('{"object_kind":"push"}', { "X-Gitlab-Token": "whsec" });
    const deps = mocks.handle.mock.calls[0]?.[0] as {
      requestHealthCheck(signal: HealthSignal): Promise<void>;
    };
    return deps.requestHealthCheck;
  }

  it("sends one request per scope, in one send", async () => {
    mocks.findHealthScopes.mockResolvedValue([
      { orgId: "org-1", workspaceId: null },
      { orgId: "org-1", workspaceId: "ws-1" },
    ]);
    const request = await boundRequest();
    await request(SIGNAL);
    expect(mocks.findHealthScopes).toHaveBeenCalledWith(SIGNAL);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith([
      {
        name: "steering-repo/health.requested",
        data: {
          orgId: "org-1",
          workspaceId: null,
          key: "org-1:org",
          trigger: SIGNAL.trigger,
        },
      },
      {
        name: "steering-repo/health.requested",
        data: {
          orgId: "org-1",
          workspaceId: "ws-1",
          key: "org-1:ws-1",
          trigger: SIGNAL.trigger,
        },
      },
    ]);
  });

  it("sends nothing when no scope holds the project", async () => {
    mocks.findHealthScopes.mockResolvedValue([]);
    const request = await boundRequest();
    await request(SIGNAL);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("lets a failure reach the handler, which logs it", async () => {
    mocks.findHealthScopes.mockRejectedValue(new Error("pg down"));
    const request = await boundRequest();
    await expect(request(SIGNAL)).rejects.toThrow("pg down");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
