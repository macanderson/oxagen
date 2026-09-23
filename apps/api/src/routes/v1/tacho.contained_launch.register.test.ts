import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));
import { tachoContainedLaunchRegisterRoute } from "./tacho.contained_launch.register";
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  session_uuid: "11111111-1111-4111-8111-111111111111",
  genesis_hash: `sha256:${"a".repeat(64)}`,
  measurement: {
    profile: "oxagen-linux-docker-v1",
    containerId: "b".repeat(64),
    imageDigest: `sha256:${"c".repeat(64)}`,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    gatewayOnlyEgress: true,
    workspaceOnlyWrites: true,
    readOnlyHooks: true,
  },
};
function app(key = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (key) c.set("apiKeyId", "key");
    await next();
  });
  app.route("/", tachoContainedLaunchRegisterRoute);
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ apiKeyId: "key" });
  mocks.invoke.mockResolvedValue({ registered: true });
});
describe("contained launch API", () => {
  it("dispatches through the kernel", async () => {
    const result = await app().request("/contained-launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(result.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "register_contained_launch",
      input,
      { apiKeyId: "key" },
      { surface: "api" },
    );
  });
  it("requires a machine credential before reading the body", async () => {
    const result = await app(false).request("/contained-launch", {
      method: "POST",
      body: "not json",
    });
    expect(result.status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it.each([
    ["text/plain", "{}", 415],
    ["application/json", "{", 400],
    ["application/json", "a".repeat(4097), 413],
  ])("refuses invalid transport %s", async (type, body, status) => {
    const result = await app().request("/contained-launch", {
      method: "POST",
      headers: { "content-type": String(type) },
      body: String(body),
    });
    expect(result.status).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
