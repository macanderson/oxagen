/**
 * The /api/scim/v2 adapter (#3734): the bearer token is the boundary, the
 * organization comes from the token alone, and every answer is SCIM JSON.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("@oxagen/auth/scim-token", () => ({ resolveScimToken: mocks.resolve }));
vi.mock("../lib/context", () => ({
  capabilityContext: (c: { get: (k: string) => unknown }) => ({
    orgId: c.get("orgId"),
    workspaceId: "00000000-0000-0000-0000-000000000000",
    userId: c.get("userId"),
    apiKeyId: c.get("apiKeyId"),
    requestId: "req-1",
    surface: "api",
    messageId: null,
    clientIp: null,
  }),
}));
vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { scimRoute } from "./scim";

const app = new Hono();
app.route("/api/scim/v2", scimRoute as never);

const TOKEN = "oxscim_the-rest-of-a-real-token";
const auth = { Authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.resolve.mockReset().mockResolvedValue({
    ok: true,
    tokenId: "00000000-0000-4000-8000-000000000001",
    orgId: "org-acme",
    tokenPrefix: "oxscim_the-rest-",
  });
});

describe("/api/scim/v2", () => {
  it("answers 401 in SCIM form without a bearer token, and reaches nothing", async () => {
    const res = await app.request("/api/scim/v2/Users");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/scim+json");
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "401",
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 401 for a token that does not resolve", async () => {
    mocks.resolve.mockResolvedValue({ ok: false, kind: "invalid" });
    const res = await app.request("/api/scim/v2/Users", { headers: auth });
    expect(res.status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invokes execute_scim_request as the token's organization, with no user and no key", async () => {
    mocks.invoke.mockResolvedValue({ status: 200, body: { totalResults: 0 } });
    const res = await app.request(
      '/api/scim/v2/Users?filter=userName%20eq%20%22ada%40acme.com%22',
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/scim+json");
    expect(await res.json()).toEqual({ totalResults: 0 });
    const [name, input, ctx, opts] = mocks.invoke.mock.calls[0]!;
    expect(name).toBe("execute_scim_request");
    expect(input).toEqual({
      tokenId: "00000000-0000-4000-8000-000000000001",
      method: "GET",
      path: "/Users",
      query: { filter: 'userName eq "ada@acme.com"' },
    });
    expect(ctx).toMatchObject({ orgId: "org-acme", userId: null, apiKeyId: null });
    // No surface: the contract declares none and this route is its caller.
    expect(opts).toBeUndefined();
  });

  it("takes no organization from the request itself", async () => {
    mocks.invoke.mockResolvedValue({ status: 201, body: {} });
    await app.request("/api/scim/v2/Users?orgId=org-other", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/scim+json", "X-Org-Id": "org-other" },
      body: JSON.stringify({ userName: "ada@acme.com", orgId: "org-other" }),
    });
    expect(mocks.invoke.mock.calls[0]![2]).toMatchObject({ orgId: "org-acme" });
  });

  it("passes the body and answers the status and Location the handler gave", async () => {
    mocks.invoke.mockResolvedValue({
      status: 201,
      body: { id: "u-1" },
      location: "https://app.oxagen.sh/api/scim/v2/Users/u-1",
    });
    const res = await app.request("/api/scim/v2/Users", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/scim+json" },
      body: JSON.stringify({ userName: "ada@acme.com" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(
      "https://app.oxagen.sh/api/scim/v2/Users/u-1",
    );
    expect(mocks.invoke.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: { userName: "ada@acme.com" },
    });
  });

  it("answers 204 with no body", async () => {
    mocks.invoke.mockResolvedValue({ status: 204, body: null });
    const res = await app.request("/api/scim/v2/Users/u-1", {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers invalid JSON with a SCIM invalidSyntax error", async () => {
    const res = await app.request("/api/scim/v2/Users", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/scim+json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ scimType: "invalidSyntax" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers a kernel refusal as 403 and a failure as 500, both in SCIM form", async () => {
    mocks.invoke.mockRejectedValueOnce(Object.assign(new Error("no"), { code: "authz_denied" }));
    const denied = await app.request("/api/scim/v2/Groups", { headers: auth });
    expect(denied.status).toBe(403);
    mocks.invoke.mockRejectedValueOnce(new Error("db down"));
    const failed = await app.request("/api/scim/v2/Groups", { headers: auth });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ status: "500" });
  });
});
