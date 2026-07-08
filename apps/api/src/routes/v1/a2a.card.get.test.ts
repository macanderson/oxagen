import { describe, expect, it, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: h.invoke }));

import { a2aCardGetRoute } from "./a2a.card.get";
import type { AppEnv } from "../../app";

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("orgId", "org_1");
    c.set("workspaceId", "ws_1");
    c.set("apiKeyId", "key_1");
    c.set("userId", null);
    c.set("requestId", "req_1");
    await next();
  });
  a.route("/", a2aCardGetRoute);
  return a;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /a2a/card", () => {
  it("invokes a2a.card.get with the request origin and returns the card", async () => {
    h.invoke.mockResolvedValue({ protocolVersion: "1.0", name: "X" });
    const res = await app().request("/", {
      headers: { host: "api.example.test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocolVersion).toBe("1.0");
    const [name, input] = h.invoke.mock.calls[0]!;
    expect(name).toBe("get_a2a_card");
    expect((input as { baseUrl: string }).baseUrl).toBe(
      "https://api.example.test",
    );
  });
});
