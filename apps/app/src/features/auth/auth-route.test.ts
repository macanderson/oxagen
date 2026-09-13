import { describe, expect, it, vi } from "vitest";
import {
  NO_ORG_SENTINEL,
  clientAddress,
  handleAuthRequest,
  isAuditedFailure,
} from "./auth-route";

function deps(status: number) {
  return {
    handler: vi.fn(() => Promise.resolve(new Response(null, { status }))),
    emitSecurityEvent: vi.fn(),
  };
}

function post(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers,
  });
}

describe("isAuditedFailure", () => {
  it.each([
    ["/api/auth/sign-in/email", 401],
    ["/api/auth/sign-in/social", 403],
    ["/api/auth/callback/github", 401],
    ["/api/auth/two-factor/verify-totp", 401],
    ["/api/auth/sign-in/email", 429],
  ])("audits %s → %i", (path, status) => {
    expect(isAuditedFailure(path, status)).toBe(true);
  });

  it("does not audit a success, or a failure outside sign-in", () => {
    expect(isAuditedFailure("/api/auth/sign-in/email", 200)).toBe(false);
    expect(isAuditedFailure("/api/auth/sign-up/email", 422)).toBe(false);
    expect(isAuditedFailure("/api/auth/get-session", 401)).toBe(false);
  });
});

describe("handleAuthRequest", () => {
  it("passes the request to Better Auth and returns its response", async () => {
    const d = deps(200);
    const res = await handleAuthRequest(post("/sign-in/email"), d);
    expect(res.status).toBe(200);
    expect(d.handler).toHaveBeenCalledOnce();
    expect(d.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("emits auth.sign_in_failed for a refused sign-in, with the first forwarded address", async () => {
    const d = deps(401);
    await handleAuthRequest(
      post("/sign-in/email", {
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        "user-agent": "ua",
      }),
      d,
    );
    expect(d.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.sign_in_failed",
        orgId: NO_ORG_SENTINEL,
        outcome: "deny",
        ip: "203.0.113.9",
        userAgent: "ua",
      }),
    );
  });

  it("does not emit for a GET, even on a sign-in path", async () => {
    const d = deps(401);
    await handleAuthRequest(
      new Request("http://localhost:3000/api/auth/callback/github"),
      d,
    );
    expect(d.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("answers 404 in fixture mode without loading Better Auth", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    const res = await handleAuthRequest(post("/sign-in/email"));
    expect(res.status).toBe(404);
  });
});

describe("clientAddress", () => {
  it("prefers x-forwarded-for, then x-real-ip", () => {
    expect(clientAddress(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe(
      "198.51.100.2",
    );
    expect(clientAddress(new Headers())).toBeNull();
  });
});
