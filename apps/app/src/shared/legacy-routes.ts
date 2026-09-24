// Appendix F legacy redirects as data (ARCHITECTURE.md §7.3). Each row maps a
// path that no longer has a page to the §1.2 page that absorbed it: the routes
// `apps/app_deprecated` shipped, and `agent-iam`, the path of the page the
// rev1 nav called Agent IAM before it became Agents (#4048). `proxy.ts`
// applies the table with a 308 for one release.
//
// Placeholders: `{org}` and `{ws}` match one path segment and carry it to the
// target; `{id}` matches one segment and is dropped; a trailing `/**` matches
// the route and anything beneath it. The first matching row wins, so the
// account rows precede the organization rows (`/account/security` is an account
// page, never an organization named `account`) and the organization rows
// precede the workspace rows (`/{org}/access/sessions` is an organization
// route, never a workspace named `access`). Every two-segment
// organization row's segment is in RESERVED_WORKSPACE_SLUGS
// (`packages/oxagen/src/contracts/org.create.ts`), so no row shadows a
// workspace's Fleet page, and `account` is in RESERVED_ORG_SLUGS.
//
// Where Appendix F sends a route to Ontology, which does not ship (decision
// log 2026-09-14), the row targets Fleet. Audit ships again (decision log
// 2026-09-15), so the deprecated app's audit route lands on the Audit page and
// the rest of the security pages still land on Organization › People. There is
// no row under `/{org}/audit`: the page is a §1.2 route and its export handler
// is a route beneath it, so a catch-all row there would swallow the download.

type OrganizationTarget =
  | "/"
  | "/{org}"
  | "/{org}/api-keys"
  | "/{org}/audit"
  | "/{org}/billing"
  | "/{org}/model-funding";

type WorkspaceTarget =
  | OrganizationTarget
  | "/{org}/{ws}"
  | "/{org}/{ws}/agents"
  | "/{org}/{ws}/tools"
  | "/{org}/{ws}/skills"
  | "/{org}/{ws}/steering"
  | "/{org}/{ws}/spend";

/** Skills moved under Steering after the legacy route table was introduced. */
type WorkspaceTargetWithQuery =
  | WorkspaceTarget
  | "/{org}/{ws}/steering?tab=skills";

/** A target may name `{ws}` only when its source captured one. */
type LegacyRoute =
  | {
      readonly from: `/{org}/{ws}/${string}`;
      readonly to: WorkspaceTargetWithQuery;
    }
  | { readonly from: `/{org}/${string}`; readonly to: OrganizationTarget }
  | { readonly from: `/account${string}`; readonly to: "/" };

export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  // Account pages become the Account dialog, which the #2968 shell lane builds.
  { from: "/account", to: "/" },
  { from: "/account/profile", to: "/" },
  { from: "/account/preferences", to: "/" },
  { from: "/account/privacy", to: "/" },
  { from: "/account/security", to: "/" },

  // Organization scope. The deprecated audit viewer is the Audit page now; the
  // rest of the security pages have no rev1 page of their own.
  { from: "/{org}/security", to: "/{org}" },
  { from: "/{org}/security/audit", to: "/{org}/audit" },
  { from: "/{org}/security/compliance", to: "/{org}" },
  { from: "/{org}/security/mfa", to: "/{org}" },
  { from: "/{org}/security/trust", to: "/{org}" },
  { from: "/{org}/governance", to: "/{org}" },
  { from: "/{org}/governance/capabilities", to: "/{org}" },
  { from: "/{org}/governance/policies", to: "/{org}" },
  { from: "/{org}/access", to: "/{org}" },
  { from: "/{org}/access/reviews", to: "/{org}" },
  { from: "/{org}/access/sessions", to: "/{org}" },
  // Organization-scope routes whose Appendix F page is workspace-scoped: the
  // proxy knows no workspace, so they land on the organization.
  { from: "/{org}/dashboard", to: "/{org}" },
  { from: "/{org}/developer/mcp", to: "/{org}" },
  { from: "/{org}/members", to: "/{org}" },
  { from: "/{org}/members/pending", to: "/{org}" },
  { from: "/{org}/workspaces", to: "/{org}" },
  { from: "/{org}/new-workspace", to: "/{org}" },
  { from: "/{org}/settings/general", to: "/{org}" },
  { from: "/{org}/settings/model-funding", to: "/{org}/model-funding" },
  { from: "/{org}/settings/privacy", to: "/{org}" },
  { from: "/{org}/developer", to: "/{org}/api-keys" },
  { from: "/{org}/developer/tokens", to: "/{org}/api-keys" },
  { from: "/{org}/billing/subscription", to: "/{org}/billing" },
  { from: "/{org}/billing/invoices", to: "/{org}/billing" },
  { from: "/{org}/billing/usage", to: "/{org}/billing" },
  { from: "/{org}/billing/governed-actions", to: "/{org}/billing" },

  // Workspace scope. Ontology does not ship: the knowledge rows go to Fleet.
  { from: "/{org}/{ws}/sessions", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/workbench", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge/citations", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge/graph", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge/graph/{id}", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge/ontology", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge/sources", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge/sources/connect", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/settings/github", to: "/{org}/{ws}" },
  { from: "/{org}/{ws}/knowledge/memory", to: "/{org}/{ws}/steering" },
  { from: "/{org}/{ws}/workbench/agents", to: "/{org}/{ws}/agents" },
  { from: "/{org}/{ws}/workbench/agents/{id}", to: "/{org}/{ws}/agents" },
  { from: "/{org}/{ws}/workbench/environments", to: "/{org}/{ws}/agents" },
  { from: "/{org}/{ws}/settings/agent-defaults", to: "/{org}/{ws}/agents" },
  // Agent IAM is the Agents page now. The row is workspace-scoped only: an
  // organization row `/{org}/agent-iam` would need the segment in
  // RESERVED_WORKSPACE_SLUGS, or it would shadow a workspace of that name.
  { from: "/{org}/{ws}/agent-iam/**", to: "/{org}/{ws}/agents" },
  { from: "/{org}/{ws}/workbench/tools", to: "/{org}/{ws}/tools" },
  { from: "/{org}/{ws}/workbench/tools/capabilities", to: "/{org}/{ws}/tools" },
  { from: "/{org}/{ws}/workbench/tools/mcp", to: "/{org}/{ws}/tools" },
  // Skills is a shelf of the Steering library. Send retired routes to the
  // Steering route, which moves `?tab=skills` to `/steering/skills`, rather
  // than through the compatibility-only /skills route (ADR-090 amendment).
  // The target stays a literal page route, as proxy.test.ts requires.
  {
    from: "/{org}/{ws}/workbench/tools/skills/**",
    to: "/{org}/{ws}/steering?tab=skills",
  },
  {
    from: "/{org}/{ws}/settings/skills",
    to: "/{org}/{ws}/steering?tab=skills",
  },
  { from: "/{org}/{ws}/marketplace", to: "/{org}/{ws}/tools" },
  { from: "/{org}/{ws}/marketplace/agent-tools", to: "/{org}/{ws}/tools" },
  { from: "/{org}/{ws}/marketplace/integrations", to: "/{org}/{ws}/tools" },
  {
    from: "/{org}/{ws}/marketplace/integrations/{id}",
    to: "/{org}/{ws}/tools",
  },
  {
    from: "/{org}/{ws}/settings/mcp-server-registries",
    to: "/{org}/{ws}/tools",
  },
  { from: "/{org}/{ws}/settings/spend-budgets", to: "/{org}/{ws}/spend" },
  { from: "/{org}/{ws}/settings", to: "/{org}" },
  { from: "/{org}/{ws}/settings/general", to: "/{org}" },
];
