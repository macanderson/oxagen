import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 renamed the `middleware` convention to `proxy`
// (docs/app/api-reference/file-conventions/proxy). This file runs before
// routes render and only does one thing today: permanently redirect the
// pre-rename onboarding URL to its new home.
//
// The dynamic org route segment was renamed but NOT reshaped — `/acme/...`
// resolves identically either way — so the only literal path that moved is
// the onboarding entrypoint.
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (pathname === "/new-tenant" || pathname.startsWith("/new-tenant/")) {
    const dest = pathname.replace(/^\/new-tenant/, "/new-organization");
    // 308 = permanent + method-preserving (the modern permanent redirect).
    return NextResponse.redirect(new URL(`${dest}${search}`, request.url), 308);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/new-tenant", "/new-tenant/:path*"],
};
