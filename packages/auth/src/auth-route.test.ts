import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handler = vi.fn(() =>
  Promise.resolve(new Response(null, { status: 403 })),
);
const emitSecurityEvent = vi.fn();
vi.mock("./auth", () => ({ auth: { handler } }));
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent }));
import {
  NO_ORG_SENTINEL,
  __resetTrustedProxyHopsForTests,
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

  it("emits auth.sign_in_failed for a refused sign-in, with the proxy-written address", async () => {
    // 203.0.113.9 is what the caller put in the header; 10.0.0.1 is what the
    // ALB appended. The record has to name the second one (ADR-083).
    __resetTrustedProxyHopsForTests();
    vi.stubEnv("TRUSTED_PROXY_HOP_COUNT", "1");
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
        ip: "10.0.0.1",
        userAgent: "ua",
      }),
    );
    __resetTrustedProxyHopsForTests();
    vi.unstubAllEnvs();
  });

  it("does not emit for a GET, even on a sign-in path", async () => {
    const d = deps(401);
    await handleAuthRequest(
      new Request("http://localhost:3000/api/auth/callback/github"),
      d,
    );
    expect(d.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

describe("handleAuthRequest without deps", () => {
  it("loads Better Auth and the security emitter itself", async () => {
    // The edge header, not x-real-ip: nothing in front of this process sets
    // x-real-ip, so a value under that name came from the caller (ADR-083).
    // The header is believed only with the gate on, which is the state after
    // the operator has deployed the Caddy config that SETS it.
    __resetTrustedProxyHopsForTests();
    vi.stubEnv("TRUST_EDGE_CLIENT_IP_HEADER", "true");
    const res = await handleAuthRequest(
      post("/sign-in/social", { "x-oxagen-client-ip": "198.51.100.7" }),
    );
    expect(res.status).toBe(403);
    expect(handler).toHaveBeenCalledOnce();
    expect(emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "198.51.100.7", userAgent: null }),
    );
    __resetTrustedProxyHopsForTests();
    vi.unstubAllEnvs();
  });
});

describe("clientAddress", () => {
  beforeEach(() => {
    __resetTrustedProxyHopsForTests();
    vi.stubEnv("TRUSTED_PROXY_HOP_COUNT", "2");
  });
  afterEach(() => {
    __resetTrustedProxyHopsForTests();
    vi.unstubAllEnvs();
  });

  it("prefers the address the edge wrote", () => {
    __resetTrustedProxyHopsForTests();
    vi.stubEnv("TRUST_EDGE_CLIENT_IP_HEADER", "true");
    expect(
      clientAddress(
        new Headers({
          "x-oxagen-client-ip": "198.51.100.1",
          "x-forwarded-for": "203.0.113.9, 192.0.2.5",
        }),
      ),
    ).toBe("198.51.100.1");
  });

  // The #3183 second P1. The Caddy config that SETS this header ships through
  // the infra pipeline; this code ships through the application one. Until it
  // lands, the old Caddyfile has no rule for the header name and forwards a
  // caller-supplied copy unchanged — and this value goes into an audit record
  // naming who tried to sign in.
  //
  // Asserting only "the edge header wins when present" passes against the
  // flagged implementation, so this forges it and asserts it does not land.
  it("does not believe a forged edge header before the gate is turned on", () => {
    expect(
      clientAddress(new Headers({ "x-oxagen-client-ip": "198.51.100.1" })),
    ).toBeNull();

    expect(
      clientAddress(
        new Headers({
          "x-oxagen-client-ip": "198.51.100.1",
          "x-forwarded-for": "203.0.113.9, 192.0.2.5",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  // ADR-083. This stamps an auth.sign_in_failed audit record, and it read the
  // leftmost x-forwarded-for entry — which behind the ALB is whatever the
  // caller typed, so the record named an address the attacker chose.
  it("ignores a caller-supplied x-forwarded-for prefix", () => {
    expect(
      clientAddress(
        new Headers({
          "x-forwarded-for": "203.0.113.9, 198.51.100.1, 172.31.0.4",
        }),
      ),
    ).toBe("198.51.100.1");
  });

  it("never believes x-real-ip, which nothing in front of this process sets", () => {
    expect(
      clientAddress(new Headers({ "x-real-ip": "198.51.100.2" })),
    ).toBeNull();
  });

  it("returns null when no trusted proxy named the caller", () => {
    expect(clientAddress(new Headers())).toBeNull();
  });
});
