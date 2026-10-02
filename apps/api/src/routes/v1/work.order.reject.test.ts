import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { workOrderRejectRoute } from "./work.order.reject";

const LIMIT = 16 * 1024;
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  work_order_id: "wo_3d4e5f",
  reason: "Claude Code is signed out on this machine.",
};
const answer = { repeat: false };

function app(authenticated = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("apiKeyId", "host-key");
    await next();
  });
  app.route("/v1/tacho", workOrderRejectRoute);
  return app;
}

function request(body = JSON.stringify(input), type = "application/json") {
  return new Request("http://localhost/v1/tacho/work-orders/reject", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ apiKeyId: "host-key" });
  mocks.invoke.mockResolvedValue(answer);
});

describe("host work order rejection endpoint", () => {
  it("requires a host API key before reading a body", async () => {
    expect((await app(false).fetch(request("invalid-json"))).status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes validated input through the kernel on the API surface", async () => {
    const res = await app().fetch(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "reject_work_order",
      input,
      { apiKeyId: "host-key" },
      { surface: "api" },
    );
  });

  it("reads a body at its 16 KiB limit", async () => {
    const json = JSON.stringify(input);
    const body = `${json}${" ".repeat(LIMIT - json.length)}`;
    expect(body.length).toBe(LIMIT);
    expect((await app().fetch(request(body))).status).toBe(200);
  });

  it("refuses a body its contract does not accept before it invokes", async () => {
    const res = await app().fetch(request(JSON.stringify({ ...input, reason: "" })));
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", "application/json", 400],
    ["{}", "text/plain", 415],
    ["x".repeat(LIMIT + 1), "application/json", 413],
  ])("rejects invalid transport %#", async (body, type, status) => {
    expect(
      (await app().fetch(request(String(body), String(type)))).status,
    ).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
