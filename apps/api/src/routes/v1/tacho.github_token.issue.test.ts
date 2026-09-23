import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));
import { tachoGithubTokenIssueRoute } from "./tacho.github_token.issue";
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  owner: "acme",
  name: "repo",
  run_token_id: "rt_0123456789abcdef0123",
};
function app(authenticated = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("apiKeyId", "host-key");
    await next();
  });
  app.route("/v1/tacho", tachoGithubTokenIssueRoute);
  return app;
}
function request(body = JSON.stringify(input), type = "application/json") {
  return new Request("http://localhost/v1/tacho/github-token", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ apiKeyId: "host-key" });
  mocks.invoke.mockResolvedValue({
    token: "scoped",
    expires_at: "2027-01-01T00:00:00Z",
    repository: {
      owner: "acme",
      name: "repo",
      full_name: "acme/repo",
      role: "main",
    },
  });
});
describe("GitHub credential control endpoint", () => {
  it("requires a host API key before reading a body", async () => {
    expect((await app(false).fetch(request("invalid-json"))).status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("passes validated input through the kernel on the API surface", async () => {
    expect((await app().fetch(request())).status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_github_token",
      input,
      { apiKeyId: "host-key" },
      { surface: "api" },
    );
  });
  it.each([
    ["invalid", "application/json", 400],
    ["{}", "text/plain", 415],
    ["x".repeat(4097), "application/json", 413],
  ])("rejects invalid transport %s", async (body, type, status) => {
    expect(
      (await app().fetch(request(String(body), String(type)))).status,
    ).toBe(status);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
