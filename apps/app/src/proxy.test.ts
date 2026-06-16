/**
 * proxy.test.ts — edge redirect + auth-boundary behavior.
 *
 * Locks the IA realignment redirects (§16) and, critically, the fix for the
 * agents redirect loop: /agents 301s to /automation/agents, and
 * /automation/agents must NOT redirect (it renders the real page). If those two
 * ever both redirect again the app dead-loops with ERR_TOO_MANY_REDIRECTS.
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
  it("301s /agents → /automation/agents (agents are an Automation tab)", () => {
    expect(location("/acme/prod/agents")).toBe(`${ORIGIN}/acme/prod/automation/agents`);
    expect(status("/acme/prod/agents")).toBe(301);
  });

  it("301s nested /agents/:slug → /automation/agents/:slug (tail preserved)", () => {
    expect(location("/acme/prod/agents/repo-review/edit")).toBe(
      `${ORIGIN}/acme/prod/automation/agents/repo-review/edit`,
    );
  });

  it("301s /agents/runs → /activity/runs BEFORE the general /agents rule", () => {
    expect(location("/acme/prod/agents/runs")).toBe(`${ORIGIN}/acme/prod/activity/runs`);
    expect(location("/acme/prod/agents/runs/fan_1")).toBe(
      `${ORIGIN}/acme/prod/activity/runs/fan_1`,
    );
  });

  it("301s /workflows → /activity/runs (folded in; banned term §19)", () => {
    expect(location("/acme/prod/workflows")).toBe(`${ORIGIN}/acme/prod/activity/runs`);
    expect(location("/acme/prod/workflows/anything")).toBe(`${ORIGIN}/acme/prod/activity/runs`);
  });

  it("301s legacy /executions and /playbooks and /chat", () => {
    expect(location("/acme/prod/executions")).toBe(`${ORIGIN}/acme/prod/activity/runs`);
    expect(location("/acme/prod/playbooks")).toBe(`${ORIGIN}/acme/prod/automation/playbooks`);
    expect(location("/acme/prod/chat")).toBe(`${ORIGIN}/acme/prod/ask`);
  });
});

describe("proxy — no redirect loop", () => {
  it("does NOT redirect the canonical /automation/agents target", () => {
    // The real agents page lives here; redirecting it would re-loop into /agents.
    expect(location("/acme/prod/automation/agents")).toBeNull();
    expect(location("/acme/prod/automation/agents/repo-review")).toBeNull();
  });

  it("does NOT redirect the canonical /activity/runs target", () => {
    expect(location("/acme/prod/activity/runs")).toBeNull();
    expect(location("/acme/prod/activity/runs/fan_1")).toBeNull();
  });

  it("leaves unrelated workspace and org routes untouched", () => {
    expect(location("/acme/prod/knowledge/sources")).toBeNull();
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

  it("308s the pre-rename onboarding entrypoint", () => {
    expect(status("/new-tenant")).toBe(308);
    expect(location("/new-tenant")).toBe(`${ORIGIN}/new-organization`);
  });
});
