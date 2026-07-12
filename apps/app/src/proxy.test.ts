/**
 * proxy.test.ts — edge redirect + auth-boundary behavior.
 *
 * Locks the IA realignment redirects (§16). web-app-2.0 Phase 0 collapsed the
 * page-level redirect shims and relocated their redirects here, so the edge now
 * carries the full rename map (renamed-but-live routes → their new homes) plus
 * the org-scope settings→top-level promotions. RETIRED feature areas (the old
 * Automation/Activity paths: agents, playbooks, workflows, executions, runs)
 * are deliberately NOT in the map — they 404 rather than dead-redirect.
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
  it("301s legacy /chat → /ask (tail collapses)", () => {
    expect(location("/acme/prod/chat")).toBe(`${ORIGIN}/acme/prod/ask`);
    expect(status("/acme/prod/chat")).toBe(301);
    expect(location("/acme/prod/chat/anything")).toBe(`${ORIGIN}/acme/prod/ask`);
  });

  it("301s /studio/* → /workbench/* preserving the tail (1:1 section rename)", () => {
    expect(location("/acme/prod/studio")).toBe(`${ORIGIN}/acme/prod/workbench`);
    expect(location("/acme/prod/studio/agents/repo-review")).toBe(
      `${ORIGIN}/acme/prod/workbench/agents/repo-review`,
    );
    expect(status("/acme/prod/studio")).toBe(301);
  });

  it("301s the workbench/settings Skills shims → /workbench/tools/skills (tail preserved)", () => {
    expect(location("/acme/prod/workbench/skills")).toBe(
      `${ORIGIN}/acme/prod/workbench/tools/skills`,
    );
    expect(location("/acme/prod/workbench/skills/my-skill")).toBe(
      `${ORIGIN}/acme/prod/workbench/tools/skills/my-skill`,
    );
    expect(location("/acme/prod/settings/skills")).toBe(
      `${ORIGIN}/acme/prod/workbench/tools/skills`,
    );
    expect(location("/acme/prod/settings/skills/my-skill")).toBe(
      `${ORIGIN}/acme/prod/workbench/tools/skills/my-skill`,
    );
  });

  it("301s the retired settings tool tabs → their Workbench homes", () => {
    expect(location("/acme/prod/settings/plugins")).toBe(
      `${ORIGIN}/acme/prod/workbench/tools/capabilities`,
    );
    expect(location("/acme/prod/settings/environments")).toBe(
      `${ORIGIN}/acme/prod/workbench/environments`,
    );
  });

  it("301s the legacy marketplace tabs → their new homes", () => {
    expect(location("/acme/prod/marketplace/browse")).toBe(
      `${ORIGIN}/acme/prod/marketplace/agent-tools`,
    );
    expect(location("/acme/prod/marketplace/installed")).toBe(
      `${ORIGIN}/acme/prod/workbench/tools/capabilities`,
    );
    expect(location("/acme/prod/marketplace/mcp")).toBe(
      `${ORIGIN}/acme/prod/workbench/tools/mcp`,
    );
  });

  it("301s the bare /knowledge/nodes index → /knowledge/inference but NEVER the node-detail route", () => {
    expect(location("/acme/prod/knowledge/nodes")).toBe(
      `${ORIGIN}/acme/prod/knowledge/inference`,
    );
    // The real node-detail page /knowledge/nodes/{id} must fall through untouched.
    expect(location("/acme/prod/knowledge/nodes/n_abc123")).toBeNull();
  });

  it("301s org-scope settings tabs promoted to top-level org sections", () => {
    expect(location("/acme/settings/billing")).toBe(`${ORIGIN}/acme/billing`);
    expect(location("/acme/settings/members")).toBe(`${ORIGIN}/acme/members`);
    expect(status("/acme/settings/billing")).toBe(301);
  });

  it("does NOT confuse workspace-scope settings with the org-scope promotion", () => {
    // /{org}/{ws}/settings/members and /settings/general are REAL workspace pages —
    // the org-scope rule only fires when `settings` is the 2nd path segment.
    expect(location("/acme/prod/settings/members")).toBeNull();
    expect(location("/acme/prod/settings/general")).toBeNull();
  });

  it("preserves the query string across a rename redirect", () => {
    expect(location("/acme/prod/chat?c=thread_1")).toBe(
      `${ORIGIN}/acme/prod/ask?c=thread_1`,
    );
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
