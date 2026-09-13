import "server-only";
import { headers } from "next/headers";

export interface RequestScopeSlugs {
  orgSlug: string | undefined;
  workspaceSlug: string | undefined;
}

/**
 * Route slugs parsed from the request path via the `x-url` header (set in
 * `proxy.ts`) instead of the route `params` object.
 *
 * WHY NOT `params`: under Next 16 Cache Components (PPR), awaiting `params` in a
 * Server Component that then calls `redirect()` degrades the redirect from a
 * clean HTTP 307 into a client-rendered `<meta http-equiv="refresh">` fallback —
 * Next logs "Switched to client rendering because the server rendering errored:
 * NEXT_REDIRECT". Inside the app-shell layout tree that forced client re-render
 * throws, surfacing global-error ("Something went wrong"), so every parent
 * "default tab" redirect page 500s. `headers()` / `cookies()` / `searchParams`
 * do NOT trigger this — only `params` regresses — so redirect pages read their
 * slugs from the URL. This mirrors the `x-url` read the org and workspace
 * layouts already do; the slug is canonical here because those layouts resolve
 * slug-history 308s before any page renders.
 */
export async function requestScopeSlugs(): Promise<RequestScopeSlugs> {
  const raw = (await headers()).get("x-url") ?? "/";
  let pathname = "/";
  try {
    pathname = new URL(raw, "http://internal.local").pathname;
  } catch {
    pathname = "/";
  }
  const [, orgSlug, workspaceSlug] = pathname.split("/");
  return {
    orgSlug: orgSlug || undefined,
    workspaceSlug: workspaceSlug || undefined,
  };
}
