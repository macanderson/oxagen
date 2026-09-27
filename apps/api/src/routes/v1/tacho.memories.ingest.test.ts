import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { tachoMemoriesIngestRoute } from "./tacho.memories.ingest";

const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  harness: "cursor",
  path: "/home/dev/project/.cursor/rules/memories.mdc",
  statement: "Run the migration lint before a schema change.",
};

function app(authenticated = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("apiKeyId", "host-key");
    await next();
  });
  app.route("/v1/tacho", tachoMemoriesIngestRoute);
  return app;
}

function request(body = JSON.stringify(input), type = "application/json") {
  return new Request("http://localhost/v1/tacho/memories", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ apiKeyId: "host-key" });
  mocks.invoke.mockResolvedValue({ stored: true });
});

describe("host memory endpoint", () => {
  it("requires a host API key before reading a body", async () => {
    expect((await app(false).fetch(request("invalid-json"))).status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes validated input through the kernel on the API surface", async () => {
    const res = await app().fetch(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "ingest_tacho_memories",
      input,
      { apiKeyId: "host-key" },
      { surface: "api" },
    );
  });

  it("reads a memory at the longest statement and path the contract takes", async () => {
    // Three UTF-8 bytes a character: 9,072 bytes, over the 4 KiB the
    // GitHub credential route allows.
    const body = JSON.stringify({
      ...input,
      path: "路".repeat(1024),
      statement: "記".repeat(2000),
    });
    expect((await app().fetch(request(body))).status).toBe(200);
  });

  it.each([
    ["invalid", "application/json", 400],
    ["{}", "text/plain", 415],
    ["x".repeat(32 * 1024 + 1), "application/json", 413],
  ])("rejects invalid transport %#", async (body, type, status) => {
    expect(
      (await app().fetch(request(String(body), String(type)))).status,
    ).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
