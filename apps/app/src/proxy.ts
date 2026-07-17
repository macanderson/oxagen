import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 renamed the `middleware` convention to `proxy`
// (docs/app/api-reference/file-conventions/proxy). This runs before routes
// render and does two things:
//   1. Permanently redirects the pre-rename onboarding URL to its new home.
//   2. Acts as the edge auth boundary: any page route requested without a
//      session cookie is redirected to /login. The session is still
//      validated server-side per request (lib/session.getSessionOrRedirect);
//      this guard ensures routes that lack a server-component check (or that
//      don't exist yet) can't be reached unauthenticated.

// Reachable without a session. Everything else is behind auth.
// /two-factor is the sign-in second-factor step: after password auth the user
// holds only a short-lived 2FA cookie (NOT a full session cookie), so the
// hasSession() guard below would bounce them to /login and wedge the flow.
const PUBLIC_PATHS = [
  /^\/login(?:\/|$)/,
  /^\/signup(?:\/|$)/,
  /^\/verify(?:\/|$)/,
  /^\/two-factor(?:\/|$)/,
];

// Better Auth names the session cookie `<cookiePrefix>.session_token` and adds
// a `__Secure-` prefix over HTTPS. Match any *session_token cookie so the
// guard is robust to the prefix and to the secure variant.
function hasSession(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name.endsWith("session_token") && c.value !== "");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // 0. chat_ux_v2 flag override: `?chat_ux_v2=1|0` persists a per-browser
  //    cookie override (see lib/flags.ts) and redirects to the same URL
  //    without the param, so the flag can be flipped in any environment
  //    without a redeploy. Edge-safe: cookies + redirect only.
  const chatUxV2Param = request.nextUrl.searchParams.get("chat_ux_v2");
  if (chatUxV2Param === "1" || chatUxV2Param === "0") {
    const cleaned = request.nextUrl.clone();
    cleaned.searchParams.delete("chat_ux_v2");
    const flagResponse = NextResponse.redirect(cleaned);
    flagResponse.cookies.set("chat_ux_v2", chatUxV2Param, {
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
      sameSite: "lax",
    });
    return flagResponse;
  }

  // 1. Permanent redirect of the pre-rename onboarding URL. The dynamic org
  //    route segment was renamed but NOT reshaped (`/acme/...` resolves
  //    identically), so the only literal path that moved is this entrypoint.
  if (pathname === "/new-tenant" || pathname.startsWith("/new-tenant/")) {
    const dest = pathname.replace(/^\/new-tenant/, "/new-organization");
    // 308 = permanent + method-preserving (the modern permanent redirect).
    return NextResponse.redirect(new URL(`${dest}${search}`, request.url), 308);
  }

  // 2. IA-realignment redirects (§16 of the IA spec). Legacy routes that were
  //    RENAMED but whose target still exists get a 301 (permanent, GET-preserving)
  //    so old links + bookmarks keep resolving. web-app-2.0 Phase 0 collapsed the
  //    former page-level redirect *shims* and relocated their redirects here, to
  //    the correct edge layer. RETIRED routes (the old Automation/Activity areas:
  //    agents, playbooks, workflows, executions, runs) are intentionally absent —
  //    they 404 rather than dead-redirect.
  {
    // (a) Org-scope settings tabs promoted to top-level org sections.
    //     /{org}/settings/{billing,members} → /{org}/{billing,members}. The
    //     literal `settings` 2nd segment is unambiguously org-scope (a workspace
    //     would put it 3rd), so this never touches /{org}/{ws}/settings/*.
    const orgSettingsMove = pathname.match(
      /^\/([^/]+)\/settings\/(billing|members)(?:\/.*)?$/,
    );
    if (orgSettingsMove) {
      const orgSlug = orgSettingsMove[1] ?? "";
      const target = orgSettingsMove[2] ?? "";
      return NextResponse.redirect(
        new URL(`/${orgSlug}/${target}${search}`, request.url),
        301,
      );
    }

    // (b) Workspace-scope renames: /{org}/{ws}/{from}(/{tail})? → …/{to}(/{tail})?
    //     preserveTail keeps the sub-path (/studio/agents → /workbench/agents);
    //     otherwise the tail collapses onto the target. `exact` entries match the
    //     bare path only.
    //
    //     web-app-2.0 Phase 2 (Knowledge IA): knowledge/repos → sources,
    //     knowledge/explore → graph, knowledge/memories → memory, and the
    //     ontology/schema builder moved out of Settings into Knowledge
    //     (settings/knowledge → knowledge/ontology). Node detail moved under
    //     Graph: knowledge/nodes/{id} → knowledge/graph/{id} (preserveTail),
    //     while the bare knowledge/nodes browse index → knowledge/graph.
    const WS_RENAMES: {
      from: string;
      to: string;
      preserveTail: boolean;
      exact?: boolean;
    }[] = [
      // web-app: the workspace chat surface was renamed Ask → Sessions. Old
      // /chat and /ask links (and their tails) 301 to /sessions.
      { from: "chat", to: "sessions", preserveTail: false },
      { from: "ask", to: "sessions", preserveTail: false },
      { from: "studio", to: "workbench", preserveTail: true },
      {
        from: "workbench/skills",
        to: "workbench/tools/skills",
        preserveTail: true,
      },
      {
        from: "settings/skills",
        to: "workbench/tools/skills",
        preserveTail: true,
      },
      {
        from: "settings/plugins",
        to: "workbench/tools/capabilities",
        preserveTail: false,
        exact: true,
      },
      {
        from: "settings/environments",
        to: "workbench/environments",
        preserveTail: false,
        exact: true,
      },
      {
        from: "settings/knowledge",
        to: "knowledge/ontology",
        preserveTail: false,
        exact: true,
      },
      // web-app-2.0 Phase 2 Settings consolidation: Models·Budget·Prompts·
      // Memory-policy merged into Agent Defaults; Members folded into General.
      {
        from: "settings/models",
        to: "settings/agent-defaults",
        preserveTail: false,
        exact: true,
      },
      {
        from: "settings/budget",
        to: "settings/agent-defaults",
        preserveTail: false,
        exact: true,
      },
      {
        from: "settings/prompts",
        to: "settings/agent-defaults",
        preserveTail: false,
        exact: true,
      },
      {
        from: "settings/memory",
        to: "settings/agent-defaults",
        preserveTail: false,
        exact: true,
      },
      {
        from: "settings/members",
        to: "settings/general",
        preserveTail: false,
        exact: true,
      },
      {
        from: "marketplace/browse",
        to: "marketplace/agent-tools",
        preserveTail: false,
        exact: true,
      },
      {
        from: "marketplace/installed",
        to: "workbench/tools/capabilities",
        preserveTail: false,
        exact: true,
      },
      {
        from: "marketplace/mcp",
        to: "workbench/tools/mcp",
        preserveTail: false,
        exact: true,
      },
      // Knowledge renames. `knowledge/nodes/{id}` must precede the bare-index
      // entry: preserveTail moves the node id onto the Graph child route.
      { from: "knowledge/repos", to: "knowledge/sources", preserveTail: true },
      { from: "knowledge/explore", to: "knowledge/graph", preserveTail: true },
      {
        from: "knowledge/memories",
        to: "knowledge/memory",
        preserveTail: true,
      },
      { from: "knowledge/nodes", to: "knowledge/graph", preserveTail: true },
    ];
    const wsRouteMove = pathname.match(/^(\/[^/]+\/[^/]+)\/(.*)$/);
    if (wsRouteMove) {
      const wsBase = wsRouteMove[1] ?? "";
      const rest = wsRouteMove[2] ?? "";
      for (const r of WS_RENAMES) {
        const exactHit = rest === r.from;
        const prefixHit = !r.exact && rest.startsWith(`${r.from}/`);
        if (exactHit || prefixHit) {
          const tail =
            r.preserveTail && prefixHit ? rest.slice(r.from.length) : "";
          return NextResponse.redirect(
            new URL(`${wsBase}/${r.to}${tail}${search}`, request.url),
            301,
          );
        }
      }
    }
  }

  // 3. Surface the request URL on a request header so RSCs and layouts can
  //    read pathname + search reliably. Next.js does NOT expose either to RSC
  //    natively — the slug-history resolver (OXA-1779) needs them to build a
  //    redirect URL that preserves the rest of the path and the query.
  const downstreamHeaders = new Headers(request.headers);
  downstreamHeaders.set(
    "x-url",
    request.nextUrl.pathname + request.nextUrl.search,
  );

  // 4. Public pages need no session.
  if (PUBLIC_PATHS.some((re) => re.test(pathname))) {
    return NextResponse.next({ request: { headers: downstreamHeaders } });
  }

  // 5. Auth boundary for every other matched (page) route.
  if (!hasSession(request)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next({ request: { headers: downstreamHeaders } });
}

export const config = {
  // Run on page routes only — exclude Next internals, static assets, and all
  // API routes (`/api/auth/*` must stay reachable to establish a session, and
  // other API routes enforce their own auth).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
