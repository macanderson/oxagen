import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { tachoSessionHeadsListRoute } from "./tacho.session_heads.list";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  session_uuids: [UUID],
  harness_session_ids: ["0b1f0000-0000-4000-8000-00000000b001"],
};

const output = {
  sessions: [
    {
      session_uuid: UUID,
      harness_session_id: "0b1f0000-0000-4000-8000-00000000b001",
      seq_count: 42,
      record_basis: "backfill",
      backfill_normalizer: "1",
    },
  ],
};

function app(authenticated = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("apiKeyId", "host-key");
    await next();
  });
  app.route("/v1/tacho", tachoSessionHeadsListRoute);
  return app;
}

function request(body = JSON.stringify(input), type = "application/json") {
  return new Request("http://localhost/v1/tacho/sessions/heads", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ apiKeyId: "host-key" });
  mocks.invoke.mockResolvedValue(output);
});

describe("backfill session heads endpoint", () => {
  it("requires a host API key before reading a body", async () => {
    expect((await app(false).fetch(request("invalid-json"))).status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes validated input through the kernel on the API surface", async () => {
    const res = await app().fetch(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_tacho_session_heads",
      input,
      { apiKeyId: "host-key" },
      { surface: "api" },
    );
  });

  it("reads the largest body the contract takes", async () => {
    const body = JSON.stringify({
      host_enrollment_id: input.host_enrollment_id,
      session_uuids: Array.from({ length: 500 }, () => UUID),
      harness_session_ids: Array.from({ length: 500 }, () => "a".repeat(128)),
    });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(64 * 1024);
    expect((await app().fetch(request(body))).status).toBe(200);
  });

  it.each([
    ["invalid", "application/json", 400],
    ["{}", "text/plain", 415],
    ["x".repeat(128 * 1024 + 1), "application/json", 413],
  ])("rejects invalid transport %#", async (body, type, status) => {
    expect(
      (await app().fetch(request(String(body), String(type)))).status,
    ).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
