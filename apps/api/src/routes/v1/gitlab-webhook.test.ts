// The route is a thin adapter over `handleGitLabWebhook`: it forwards the
// connection id, the `X-Gitlab-Token` header and the parsed body, and answers
// the handler's status and outcome.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  deps: { marker: "deps" },
}));

vi.mock("@oxagen/handlers/gitlab.webhook", () => ({
  handleGitLabWebhook: mocks.handle,
  gitlabWebhookDeps: () => mocks.deps,
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
