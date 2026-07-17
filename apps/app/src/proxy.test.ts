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

function req(
  path: string,
  { authed = true }: { authed?: boolean } = {},
): NextRequest {
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
  it("301s legacy /chat → /sessions (tail collapses)", () => {
    expect(location("/acme/prod/chat")).toBe(`${ORIGIN}/acme/prod/sessions`);
    expect(status("/acme/prod/chat")).toBe(301);
    expect(location("/acme/prod/chat/anything")).toBe(
      `${ORIGIN}/acme/prod/sessions`,
    );
  });

  it("301s legacy /ask → /sessions (rename; tail collapses, query preserved)", () => {
    expect(location("/acme/prod/ask")).toBe(`${ORIGIN}/acme/prod/sessions`);
    expect(status("/acme/prod/ask")).toBe(301);
    expect(location("/acme/prod/ask/anything")).toBe(
      `${ORIGIN}/acme/prod/sessions`,
    );
    expect(location("/acme/prod/ask?c=cnv_1")).toBe(
      `${ORIGIN}/acme/prod/sessions?c=cnv_1`,
    );
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

  it("301s the web-app-2.0 Knowledge renames → their new tab homes", () => {
    // repos → sources, explore → graph, memories → memory (bare + tail).
    expect(location("/acme/prod/knowledge/repos")).toBe(
      `${ORIGIN}/acme/prod/knowledge/sources`,
    );
    expect(location("/acme/prod/knowledge/explore")).toBe(
      `${ORIGIN}/acme/prod/knowledge/graph`,
    );
    expect(location("/acme/prod/knowledge/memories")).toBe(
      `${ORIGIN}/acme/prod/knowledge/memory`,
    );
    // The ontology/schema builder moved out of Settings into Knowledge.
    expect(location("/acme/prod/settings/knowledge")).toBe(
      `${ORIGIN}/acme/prod/knowledge/ontology`,
    );
  });

  it("301s /knowledge/nodes → Graph: bare index to /knowledge/graph, node detail preserving the id", () => {
    expect(location("/acme/prod/knowledge/nodes")).toBe(
      `${ORIGIN}/acme/prod/knowledge/graph`,
    );
    // Node detail moved under Graph: /knowledge/nodes/{id} → /knowledge/graph/{id}.
    expect(location("/acme/prod/knowledge/nodes/n_abc123")).toBe(
      `${ORIGIN}/acme/prod/knowledge/graph/n_abc123`,
    );
  });

  it("301s org-scope settings tabs promoted to top-level org sections", () => {
    expect(location("/acme/settings/billing")).toBe(`${ORIGIN}/acme/billing`);
    expect(location("/acme/settings/members")).toBe(`${ORIGIN}/acme/members`);
    expect(status("/acme/settings/billing")).toBe(301);
  });

  it("does NOT confuse workspace-scope settings with the org-scope promotion", () => {
    // /settings/general is a REAL workspace page (no redirect). The org-scope
    // promotion rule only fires when `settings` is the 2nd path segment; the
    // workspace-scope settings/members redirect below is a DIFFERENT rule.
    expect(location("/acme/prod/settings/general")).toBeNull();
  });

  it("301s the web-app-2.0 Settings consolidation → General + Agent Defaults", () => {
    // Members folded into General; Models·Budget·Prompts·Memory-policy merged
    // into Agent Defaults.
    expect(location("/acme/prod/settings/members")).toBe(
      `${ORIGIN}/acme/prod/settings/general`,
    );
    for (const tab of ["models", "budget", "prompts", "memory"]) {
      expect(location(`/acme/prod/settings/${tab}`)).toBe(
        `${ORIGIN}/acme/prod/settings/agent-defaults`,
      );
    }
    // The consolidated targets themselves must NOT redirect (no loop).
    expect(location("/acme/prod/settings/agent-defaults")).toBeNull();
  });

  it("preserves the query string across a rename redirect", () => {
    expect(location("/acme/prod/chat?c=thread_1")).toBe(
      `${ORIGIN}/acme/prod/sessions?c=thread_1`,
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

describe("proxy — chat_ux_v2 flag override", () => {
  it("persists ?chat_ux_v2=1 as a cookie and redirects to the cleaned URL", () => {
    const res = proxy(req("/acme/prod/sessions?chat_ux_v2=1&c=cnv_1"));
    expect(res.headers.get("location")).toBe(
      `${ORIGIN}/acme/prod/sessions?c=cnv_1`,
    );
    expect(res.cookies.get("chat_ux_v2")?.value).toBe("1");
  });

  it("persists the off override too", () => {
    const res = proxy(req("/acme/prod/sessions?chat_ux_v2=0"));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/acme/prod/sessions`);
    expect(res.cookies.get("chat_ux_v2")?.value).toBe("0");
  });

  it("ignores garbage values — no cookie, no redirect", () => {
    const res = proxy(req("/acme/prod/sessions?chat_ux_v2=yes"));
    expect(res.cookies.get("chat_ux_v2")).toBeUndefined();
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy — no redirect loop", () => {
  it("leaves unrelated workspace and org routes untouched", () => {
    // The renamed Knowledge targets themselves must NOT redirect (no loop).
    expect(location("/acme/prod/knowledge/sources")).toBeNull();
    expect(location("/acme/prod/knowledge/graph")).toBeNull();
    expect(location("/acme/prod/knowledge/graph/n_abc123")).toBeNull();
    expect(location("/acme/prod/knowledge/memory")).toBeNull();
    expect(location("/acme/prod/knowledge/ontology")).toBeNull();
    expect(location("/acme/settings/general")).toBeNull();
    expect(location("/acme/developer/mcp")).toBeNull();
  });
});

describe("proxy — auth boundary", () => {
  it("redirects unauthenticated page requests to /login", () => {
    expect(location("/acme/prod/sessions", { authed: false })).toBe(
      `${ORIGIN}/login`,
    );
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
