/**
 * proxy.test.ts — edge redirect + auth-boundary behavior.
 *
 * Locks the IA realignment redirects (§16). The Automation and Activity
 * feature areas (agents, playbooks, workflows, executions, runs) were removed
 * entirely, so their legacy paths no longer redirect anywhere — they fall
 * through to the normal auth/next handling like any other unmatched route.
 * The only surviving rename redirect is the legacy /chat → /ask alias.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const ORIGIN = "https://app.test";

function req(path: string, { authed = true }: { authed?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (authed) headers.cookie = "better-auth.session_token=tok";
  return new NextRequest(new URL(`${ORIGIN}${path}`), { headers });
}

function location(path: string, opts?: { authed?: boolean }): string | null {
  return proxy(req(path, opts)).headers.get("location");
}

function status(path: string, opts?: { authed?: boolean }): number {
  return proxy(req(path, opts)).status;
}

describe("proxy — IA realignment redirects (§16)", () => {
  it("301s legacy /chat → /ask (only surviving rename redirect)", () => {
    expect(location("/acme/prod/chat")).toBe(`${ORIGIN}/acme/prod/ask`);
    expect(status("/acme/prod/chat")).toBe(301);
  });

  it("301s nested /chat/* → /ask (tail collapses to the ask route)", () => {
    expect(location("/acme/prod/chat/anything")).toBe(`${ORIGIN}/acme/prod/ask`);
  });

  it("does NOT redirect the deleted Automation/Activity legacy paths (authed request falls through)", () => {
    // /agents, /agents/:slug, /agents/runs, /workflows, /executions, /playbooks
    // used to redirect into the Automation/Activity areas; those areas were
    // deleted entirely, so these paths no longer redirect anywhere — they
    // fall through to the normal auth/next handling (no 301).
    expect(location("/acme/prod/agents")).toBeNull();
    expect(location("/acme/prod/agents/repo-review/edit")).toBeNull();
    expect(location("/acme/prod/agents/runs")).toBeNull();
    expect(location("/acme/prod/agents/runs/fan_1")).toBeNull();
    expect(location("/acme/prod/workflows")).toBeNull();
    expect(location("/acme/prod/workflows/anything")).toBeNull();
    expect(location("/acme/prod/executions")).toBeNull();
    expect(location("/acme/prod/playbooks")).toBeNull();
  });
});

describe("proxy — no redirect loop", () => {
  it("leaves unrelated workspace and org routes untouched", () => {
    expect(location("/acme/prod/knowledge/repos")).toBeNull();
    expect(location("/acme/settings/general")).toBeNull();
    expect(location("/acme/developer/mcp")).toBeNull();
  });
});

describe("proxy — auth boundary", () => {
  it("redirects unauthenticated page requests to /login", () => {
    expect(location("/acme/prod/ask", { authed: false })).toBe(`${ORIGIN}/login`);
  });

  it("allows public auth pages without a session", () => {
    expect(location("/login", { authed: false })).toBeNull();
    expect(location("/signup", { authed: false })).toBeNull();
  });

  it("allows /two-factor without a full session (sign-in second factor)", () => {
    // After password auth the user holds only the short-lived 2FA cookie, not a
    // session_token — the gate must NOT bounce them to /login or the flow wedges.
    expect(location("/two-factor", { authed: false })).toBeNull();
    expect(location("/two-factor/verify", { authed: false })).toBeNull();
  });

  it("308s the pre-rename onboarding entrypoint", () => {
    expect(status("/new-tenant")).toBe(308);
    expect(location("/new-tenant")).toBe(`${ORIGIN}/new-organization`);
  });
});
