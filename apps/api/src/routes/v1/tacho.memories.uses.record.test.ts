import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { tachoMemoryUsesRecordRoute } from "./tacho.memories.uses.record";

const ROOT = "/home/dev/.claude/projects/";
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  uses: [
    {
      harness: "claude-code",
      path: `${ROOT}-proj/memory/use-pnpm.md`,
      session_uuid: "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f",
      count: 2,
      used_at: "2026-10-01T12:00:00.000Z",
    },
  ],
  scans: [
    {
      harness: "claude-code",
      root: ROOT,
      paths: [`${ROOT}-proj/memory/use-pnpm.md`],
    },
  ],
  counts: [
    {
      harness: "codex",
      path: "thread/01a0e198-36ea-7e52-aedf-4b346877c10d",
      count: 3,
      used_at: "2026-10-01T12:00:00.000Z",
    },
  ],
};
const answer = { recorded: 1, unknown: 0, pending: [], retired: 0 };

function app(authenticated = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("apiKeyId", "host-key");
    await next();
  });
  app.route("/v1/tacho", tachoMemoryUsesRecordRoute);
  return app;
}

function request(body = JSON.stringify(input), type = "application/json") {
  return new Request("http://localhost/v1/tacho/memories/uses", {
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

describe("host memory uses endpoint", () => {
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
      "record_tacho_memory_uses",
      input,
      { apiKeyId: "host-key" },
      { surface: "api" },
    );
  });

  it("reads a full scan of 4,000 memory files", async () => {
    const paths = Array.from(
      { length: 4000 },
      (_, i) => `${ROOT}-Users-dev-Projects-project-${i}/memory/feedback_${i}.md`,
    );
    const body = JSON.stringify({
      ...input,
      scans: [{ harness: "claude-code", root: ROOT, paths }],
    });
    expect(body.length).toBeGreaterThan(256 * 1024);
    expect((await app().fetch(request(body))).status).toBe(200);
  });

  it.each([
    ["invalid", "application/json", 400],
    ["{}", "text/plain", 415],
    ["x".repeat(1024 * 1024 + 1), "application/json", 413],
  ])("rejects invalid transport %#", async (body, type, status) => {
    expect(
      (await app().fetch(request(String(body), String(type)))).status,
    ).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
