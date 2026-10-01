// The Linear OAuth app webhook (#4881) verifies each delivery and answers 200.
// It stores nothing until the collector framework (#4775) consumes deliveries,
// so these tests cover the signature, the replay window, and the acks that keep
// Linear from disabling the webhook.
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../../middleware/logger", () => ({
  logger: { error: mocks.logError, warn: vi.fn(), info: mocks.logInfo },
}));

const { linearWebhookRoute, LINEAR_WEBHOOK_MAX_SKEW_MS } = await import(
  "./linear-webhook"
);
const app = new Hono().route("/webhooks/linear", linearWebhookRoute);

const SECRET = "lin_wh_test_secret";

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

const delivery = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "update",
    type: "Issue",
    organizationId: "org_linear_1",
    webhookTimestamp: Date.now(),
    data: { id: "issue_1", state: { name: "Done" } },
    updatedFrom: { stateId: "state_todo" },
    ...overrides,
  });

const post = (body: string, headers: Record<string, string> = {}) =>
  app.request("/webhooks/linear", { method: "POST", body, headers });

describe("POST /webhooks/linear", () => {
  beforeEach(() => {
    vi.stubEnv("LINEAR_WEBHOOK_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("answers 200 for a correctly signed, fresh delivery", async () => {
    const body = delivery();
    const res = await post(body, {
      "linear-signature": sign(body),
      "linear-delivery": "5f0c8a1e-0000-4000-8000-000000000001",
      "linear-event": "Issue",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.logInfo).toHaveBeenCalledWith(
      {
        delivery: "5f0c8a1e-0000-4000-8000-000000000001",
        event: "Issue",
        action: "update",
        linearOrganizationId: "org_linear_1",
      },
      expect.any(String),
    );
  });

  it("refuses a delivery signed with another secret", async () => {
    const body = delivery();
    const res = await post(body, {
      "linear-signature": sign(body, "some_other_secret"),
    });

    expect(res.status).toBe(401);
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it("refuses a delivery with no signature", async () => {
    const res = await post(delivery());

    expect(res.status).toBe(401);
  });

  it("refuses a delivery whose signature has the wrong length", async () => {
    const body = delivery();
    const res = await post(body, { "linear-signature": "abc123" });

    expect(res.status).toBe(401);
  });

  it("refuses a delivery sent outside the replay window", async () => {
    const body = delivery({
      webhookTimestamp: Date.now() - LINEAR_WEBHOOK_MAX_SKEW_MS - 5_000,
    });
    const res = await post(body, { "linear-signature": sign(body) });

    expect(res.status).toBe(401);
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it("refuses a delivery with no webhookTimestamp", async () => {
    const body = delivery({ webhookTimestamp: undefined });
    const res = await post(body, { "linear-signature": sign(body) });

    expect(res.status).toBe(401);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const body = "not json";
    const res = await post(body, { "linear-signature": sign(body) });

    expect(res.status).toBe(400);
  });

  it("acks with 200 and logs when the secret is not configured", async () => {
    vi.stubEnv("LINEAR_WEBHOOK_SECRET", "");
    const body = delivery();
    const res = await post(body, { "linear-signature": sign(body) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      reason: "webhook secret not configured",
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      { reason: "linear_webhook_secret_missing" },
      expect.any(String),
    );
  });
});
