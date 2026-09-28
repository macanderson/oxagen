import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { tachoMemoriesRecallRoute } from "./tacho.memories.recall";

const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  repository: "github.com/a-intel/platform",
  tools: ["Bash", "Edit"],
  paths: ["apps/api/src/billing.ts"],
  text: "Change the proration rule.",
};

const output = {
  items: [
    {
      id: "billing-tests",
      source: "record",
      statement: "Run the billing tests before a proration change.",
      score: 0.9,
      tokens: 11,
    },
  ],
};

function app(authenticated = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("apiKeyId", "host-key");
    await next();
  });
  app.route("/v1/tacho", tachoMemoriesRecallRoute);
  return app;
}

function request(body = JSON.stringify(input), type = "application/json") {
  return new Request("http://localhost/v1/tacho/memories/recall", {
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

describe("host memory recall endpoint", () => {
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
      "recall_tacho_memories",
      input,
      { apiKeyId: "host-key" },
      { surface: "api" },
    );
  });

  it("reads a prompt at the largest body the contract takes", async () => {
    // Three UTF-8 bytes a character: about 87 KiB, over the 64 KiB the
    // bundle route allows.
    const body = JSON.stringify({
      ...input,
      repository: "倉".repeat(200),
      tools: Array.from({ length: 64 }, () => "具".repeat(200)),
      paths: Array.from({ length: 16 }, () => "路".repeat(512)),
      text: "記".repeat(8000),
    });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(64 * 1024);
    expect((await app().fetch(request(body))).status).toBe(200);
  });

  it.each([
    ["invalid", "application/json", 400],
    ["{}", "text/plain", 415],
    ["x".repeat(256 * 1024 + 1), "application/json", 413],
  ])("rejects invalid transport %#", async (body, type, status) => {
    expect(
      (await app().fetch(request(String(body), String(type)))).status,
    ).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
