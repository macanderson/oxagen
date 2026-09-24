// Which slice of a workspace's API keys a request asks for: the workspace and
// the filter. Both are query values on the one route (ARCHITECTURE.md §1.2),
// so a filtered roster survives a reload and a shared link, and a value the
// page does not understand falls back to the default rather than failing the
// page. The page size and the page are the shared list table's, in the page
// (`@/ui/list-table`), as on every other list in the design.
//
// The default, Active, shows the keys that still authenticate: not revoked,
// and not past their expiry at the instant the roster was read. A revoked or
// expired key is a record of a key, not a key, and leaving it on the roster
// pushes the live ones below it. It is still reachable: `show=all` is one
// link away and brings the ended rows back with their dates.
//
// Expiry is judged at the read instant, the one clock the server render and
// every later render of it share, never at the ticking clock a row keeps
// (`key-row.tsx`). So no row leaves the table while a reader looks at it: a key
// that expires while the page is open stays listed, its own badge turns to
// expired, and the next read files it under All.
import type { ApiKey } from "@/data/contracts/org";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

/** `active` hides revoked and expired keys (the default); `all` shows them. */
export const API_KEYS_SHOW = ["active", "all"] as const;
export type ApiKeysShow = (typeof API_KEYS_SHOW)[number];

export type ApiKeysView = {
  /** The workspace the URL named, before the page checks the viewer may enter it. */
  workspace: string | undefined;
  show: ApiKeysShow;
};

type Params = Readonly<Record<string, string | string[] | undefined>>;

export function parseApiKeysView(params: Params): ApiKeysView {
  const rawShow = firstParam(params.show);
  return {
    workspace: firstParam(params.workspace),
    show: API_KEYS_SHOW.find((s) => s === rawShow) ?? "active",
  };
}

/**
 * The route for a view. The default, the active keys, is left off the query,
 * so the plain link to the page is the plain link to the page however a
 * person arrived at it.
 */
export function apiKeysLink(
  org: string,
  to: { workspace: string; show?: ApiKeysShow },
): SafePath {
  return routes.apiKeys(org, {
    workspace: to.workspace,
    show: to.show === undefined || to.show === "active" ? undefined : to.show,
  });
}

/** Whether a key still authenticates at `now`: not revoked and not past its expiry. */
function isActive(key: ApiKey, now: number): boolean {
  return (
    key.revokedAt === null &&
    (key.expiresAt === null || Date.parse(key.expiresAt) > now)
  );
}

/** The keys this filter keeps at the read instant `now`, in the order the read returned them. */
export function filterKeys(
  keys: readonly ApiKey[],
  show: ApiKeysShow,
  now: number,
): readonly ApiKey[] {
  return show === "all" ? keys : keys.filter((key) => isActive(key, now));
}
