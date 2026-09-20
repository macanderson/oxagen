import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicPath, proxy } from "./proxy";
import { LEGACY_ROUTES } from "./shared/legacy-routes";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: cookie ? { cookie } : {},
  });
}

describe("isPublicPath", () => {
  it.each([
    "/login",
    "/signup",
    "/verify",
    "/two-factor",
    "/forgot-password",
    "/reset-password",
    "/invite/tok_123",
    "/api/auth/get-session",
    "/cli/authorize",
    "/cli/complete",
    "/github/setup",
  ])("%s is public", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/acme",
    "/acme/core-platform",
    "/loginx",
    "/invite",
    "/api/mc/acme/core-platform/stream",
    "/new-organization",
    "/cli/authorizex",
    "/cli/completex",
    "/github/setupx",
  ])("%s is gated", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("proxy", () => {
  it("lets public paths through without a session", () => {
    const res = proxy(request("/login"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects a gated path to /login and remembers where the user was going", () => {
    const res = proxy(request("/acme/core-platform/tools?tab=registry"));
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(
      "/acme/core-platform/tools?tab=registry",
    );
  });

  it("sends a signed-out organization-creation visit to /login and back", () => {
    const res = proxy(request("/new-organization"));
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe("/new-organization");
  });

  it("does not add next= for the root path", () => {
    const res = proxy(request("/"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("lifts a Better Auth OAuth error on / onto /login?error=", () => {
    const res = proxy(request("/?error=please_restart_the_process"));
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe("please_restart_the_process");
    expect(target.searchParams.get("next")).toBeNull();
  });

  it("accepts a Better Auth session cookie, secure prefix included", () => {
    expect(
      proxy(request("/acme", "better-auth.session_token=abc")).headers.get(
        "location",
      ),
    ).toBeNull();
    expect(
      proxy(
        request("/acme", "__Secure-better-auth.session_token=abc"),
      ).headers.get("location"),
    ).toBeNull();
  });

  it("rejects an empty session cookie", () => {
    expect(proxy(request("/acme", "better-auth.session_token=")).status).toBe(
      307,
    );
  });

  // The CLI's loopback listener 302s the browser here after the token exchange
  // (apps/cli/src/auth/loopback-login.ts). The browser that finished the flow
  // may hold no app cookie at all, so a gated /cli/complete ends a successful
  // production sign-in on /login (#3091).
  it("lets the CLI completion page through without a session", () => {
    const res = proxy(request("/cli/complete"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects a cookie that is not a session token (negative)", () => {
    expect(
      proxy(request("/acme/core-platform", "theme=dark; operator=marcus"))
        .status,
    ).toBe(307);
  });
});

/** The §1.2 routes: every page.tsx under src/app, route groups removed, as `/[org]/[ws]/steering`. */
const PAGE_ROUTES: ReadonlySet<string> = new Set(
  readdirSync(join(import.meta.dirname, "app"), {
    recursive: true,
    encoding: "utf8",
  })
    .map((file) => file.split(sep))
    .filter((parts) => parts.at(-1) === "page.tsx")
    .map(
      (parts) =>
        `/${parts
          .slice(0, -1)
          .filter((part) => !part.startsWith("("))
          .join("/")}`,
    ),
);

/** A table template as a page route: `/{org}/{ws}/steering` → `/[org]/[ws]/steering`. */
const pageRouteOf = (template: string): string =>
  template.replace("{org}", "[org]").replace("{ws}", "[ws]");

/** A concrete URL for a table template or a page route. */
const visit = (template: string): string =>
  template
    .replace(/\{org\}|\[org\]/, "acme")
    .replace(/\{ws\}|\[ws\]/, "core")
    .replace(/\{id\}|\[run\]/, "id_1")
    .replace("[token]", "tok_1")
    .replace("/**", "/deep/link");

function locationOf(path: string): string | null {
  const res = proxy(request(path));
  return res.status === 308
    ? new URL(res.headers.get("location") ?? "").pathname
    : null;
}

describe("legacy routes (Appendix F, ARCHITECTURE.md §7.3)", () => {
  it("finds the §1.2 routes on disk", () => {
    expect(PAGE_ROUTES).toContain("/[org]/[ws]/steering");
  });

  it.each(LEGACY_ROUTES)(
    "$from answers 308 to $to, a §1.2 route, before the session gate",
    ({ from, to }) => {
      expect(PAGE_ROUTES).toContain(pageRouteOf(to));
      expect(PAGE_ROUTES).not.toContain(pageRouteOf(from));
      const res = proxy(request(visit(from)));
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(
        new URL(visit(to), "http://localhost:3000").href,
      );
    },
  );

  it("sends no row to Ontology, and no row under the Audit export (negative)", () => {
    for (const { from, to } of LEGACY_ROUTES) {
      expect(to).not.toMatch(/ontology/);
      // Audit is a §1.2 route again (#3097), so a row may target the page
      // itself. A row *under* it would match /{org}/audit/export and answer
      // the download with a redirect, so the table carries none.
      expect(from).not.toMatch(/\{org\}\/audit(\/|$)/);
    }
  });

  // The oracle: every route apps/app_deprecated shipped outside §1.2 and the
  // two billing routes, with the page each lands on — the deprecated audit
  // viewer among them, which lands on the Audit page (#3097). Dropping a row
  // from the table fails its entry here.
  it.each([
    ["/acme/security", "/acme"],
    ["/acme/security/audit", "/acme/audit"],
    ["/acme/security/compliance", "/acme"],
    ["/acme/security/mfa", "/acme"],
    ["/acme/security/trust", "/acme"],
    ["/acme/governance", "/acme"],
    ["/acme/governance/capabilities", "/acme"],
    ["/acme/governance/policies", "/acme"],
    ["/acme/access", "/acme"],
    ["/acme/access/reviews", "/acme"],
    ["/acme/access/sessions", "/acme"],
    ["/acme/dashboard", "/acme"],
    ["/acme/developer/mcp", "/acme"],
    ["/acme/members", "/acme"],
    ["/acme/members/pending", "/acme"],
    ["/acme/workspaces", "/acme"],
    ["/acme/new-workspace", "/acme"],
    ["/acme/settings/general", "/acme"],
    ["/acme/settings/model-funding", "/acme/model-funding"],
    ["/acme/settings/privacy", "/acme"],
    ["/acme/developer", "/acme/api-keys"],
    ["/acme/developer/tokens", "/acme/api-keys"],
    ["/acme/billing/subscription", "/acme/billing"],
    ["/acme/billing/invoices", "/acme/billing"],
    ["/acme/billing/usage", "/acme/billing"],
    ["/acme/billing/governed-actions", "/acme/billing"],
    ["/acme/core/sessions", "/acme/core"],
    ["/acme/core/workbench", "/acme/core"],
    ["/acme/core/knowledge", "/acme/core"],
    ["/acme/core/knowledge/citations", "/acme/core"],
    ["/acme/core/knowledge/graph", "/acme/core"],
    ["/acme/core/knowledge/graph/node_1", "/acme/core"],
    ["/acme/core/knowledge/ontology", "/acme/core"],
    ["/acme/core/knowledge/sources", "/acme/core"],
    ["/acme/core/knowledge/sources/connect", "/acme/core"],
    ["/acme/core/settings/github", "/acme/core"],
    ["/acme/core/knowledge/memory", "/acme/core/steering"],
    ["/acme/core/workbench/agents", "/acme/core/agents"],
    ["/acme/core/workbench/agents/new", "/acme/core/agents"],
    ["/acme/core/workbench/agents/agt_1", "/acme/core/agents"],
    ["/acme/core/workbench/environments", "/acme/core/agents"],
    ["/acme/core/settings/agent-defaults", "/acme/core/agents"],
    ["/acme/core/workbench/tools", "/acme/core/tools"],
    ["/acme/core/workbench/tools/capabilities", "/acme/core/tools"],
    ["/acme/core/workbench/tools/mcp", "/acme/core/tools"],
    ["/acme/core/marketplace", "/acme/core/tools"],
    ["/acme/core/marketplace/agent-tools", "/acme/core/tools"],
    ["/acme/core/marketplace/integrations", "/acme/core/tools"],
    ["/acme/core/marketplace/integrations/github", "/acme/core/tools"],
    ["/acme/core/settings/mcp-server-registries", "/acme/core/tools"],
    ["/acme/core/workbench/tools/skills", "/acme/core/steering?tab=skills"],
    [
      "/acme/core/workbench/tools/skills/release-notes",
      "/acme/core/steering?tab=skills",
    ],
    ["/acme/core/settings/skills", "/acme/core/steering?tab=skills"],
    ["/acme/core/settings/spend-budgets", "/acme/core/spend"],
    ["/acme/core/settings", "/acme"],
    ["/acme/core/settings/general", "/acme"],
    ["/account", "/"],
    ["/account/profile", "/"],
    ["/account/preferences", "/"],
    ["/account/privacy", "/"],
    ["/account/security", "/"],
  ])("%s → %s", (legacy, page) => {
    expect(locationOf(legacy)).toBe(page);
  });

  it.each([...PAGE_ROUTES])("leaves the §1.2 route %s alone", (route) => {
    const res = proxy(request(visit(route), "better-auth.session_token=abc"));
    expect(res.headers.get("location")).toBeNull();
  });

  it.each([
    "/acme/core/knowledge/memory/extra",
    "/acme/auditx",
    "/acme/core/workbench/agents/agt_1/runs",
    "/account/profile/avatar",
  ])("does not redirect %s, which no row names (negative)", (path) => {
    expect(proxy(request(path)).status).toBe(307);
  });

  it("drops the legacy query string", () => {
    expect(
      proxy(request("/acme/core/sessions?tab=recent")).headers.get("location"),
    ).toBe("http://localhost:3000/acme/core");
  });

  it("leaves public paths to the public rule", () => {
    expect(
      proxy(request("/invite/members")).headers.get("location"),
    ).toBeNull();
  });
});
