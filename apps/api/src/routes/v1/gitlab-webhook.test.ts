// The routes are thin adapters over `handleGitLabWebhook` and
// `handleGitLabSteeringWebhook`: each forwards the path parameters, the
// `X-Gitlab-Token` header and the parsed body, and answers the handler's
// status and outcome.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  deps: { marker: "deps" },
  handleSteering: vi.fn(),
  steeringDeps: { marker: "steering-deps" },
}));

vi.mock("@oxagen/handlers/gitlab.webhook", () => ({
  handleGitLabWebhook: mocks.handle,
  gitlabWebhookDeps: () => mocks.deps,
}));

vi.mock("@oxagen/handlers/gitlab.steering-webhook", () => ({
  handleGitLabSteeringWebhook: mocks.handleSteering,
  gitlabSteeringWebhookDeps: () => mocks.steeringDeps,
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
    expect(mocks.handle).toHaveBeenCalledWith(mocks.deps, {
      connectionPublicId: "con_gl1",
      tokenHeader: "whsec",
      body: { object_kind: "merge_request" },
    });
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

describe("POST /webhooks/gitlab/steering/:scopeKind/:scopeId", () => {
  const WORKSPACE = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
  const postSteering = (
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ) =>
    app.request(`/webhooks/gitlab/steering/${path}`, {
      method: "POST",
      body,
      headers,
    });

  beforeEach(() => {
    mocks.handle.mockReset();
    mocks.handleSteering.mockReset();
  });

  it("forwards the scope, the token header and the parsed body", async () => {
    mocks.handleSteering.mockResolvedValue({
      status: 202,
      outcome: "health_requested",
    });
    const res = await postSteering(
      `workspace/${WORKSPACE}`,
      '{"object_kind":"push","ref":"refs/heads/main"}',
      { "X-Gitlab-Token": "hook-token" },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ outcome: "health_requested" });
    expect(mocks.handleSteering).toHaveBeenCalledWith(mocks.steeringDeps, {
      scopeKind: "workspace",
      scopeId: WORKSPACE,
      tokenHeader: "hook-token",
      body: { object_kind: "push", ref: "refs/heads/main" },
    });
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it("passes a missing header and an unparseable body as null", async () => {
    mocks.handleSteering.mockResolvedValue({
      status: 401,
      outcome: "unauthenticated",
    });
    const res = await postSteering(`organization/${WORKSPACE}`, "not json");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ outcome: "unauthenticated" });
    expect(mocks.handleSteering.mock.calls[0]?.[1]).toEqual({
      scopeKind: "organization",
      scopeId: WORKSPACE,
      tokenHeader: null,
      body: null,
    });
  });

  it("leaves the connection route to the connection handler", async () => {
    mocks.handle.mockResolvedValue({ status: 401, outcome: "unauthenticated" });
    await post("{}");
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(mocks.handleSteering).not.toHaveBeenCalled();
  });
});
