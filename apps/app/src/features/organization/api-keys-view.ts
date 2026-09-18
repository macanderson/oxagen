// Which slice of a workspace's API keys a request asks for: the workspace, the
// filter, and the page. All three are query values on the one route
// (ARCHITECTURE.md §1.2), so a filtered page survives a reload and a shared
// link, and a value the page does not understand falls back to the default
// rather than failing the page.
//
// The default hides revoked keys. A revoked key authenticates nothing —
// `resolveApiKey` never sees the row again — so it is a record of a key, not a
// key, and leaving it on the roster pushes the unrevoked ones below it. It
// is still reachable: `show=all` is one link away and the revoked rows come
// back with their revocation dates, which is how a person answers "was this
// one ever revoked, and when".
//
// The filter is judged on `revokedAt` alone, never on the clock. An expired key
// stays on the default roster: expiry is a state the row's own clock can cross
// while the page is open (`key-row.tsx`), and a filter that moved a row out
// from under a reader as a second ticked over would be a filter that lies. A
// revocation is recorded and cannot un-happen, so filtering on it gives the
// same roster on the server and on every later render of it.
import type { ApiKey } from "@/data/contracts/org";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

/** Rows per page. The roster is read whole, so this is where it is cut. */
export const API_KEYS_PAGE = 20;

/** `active` hides revoked keys (the default); `all` shows them. */
export const API_KEYS_SHOW = ["active", "all"] as const;
export type ApiKeysShow = (typeof API_KEYS_SHOW)[number];

export type ApiKeysView = {
  /** The workspace the URL named, before the page checks the viewer may enter it. */
  workspace: string | undefined;
  show: ApiKeysShow;
  offset: number;
};

/**
 * An offset the query may carry: a non-negative integer, without leading zeros
 * or a sign, that a double holds exactly. The digit bound is the one
 * `Number.isSafeInteger` needs to mean anything — a longer run of digits parses
 * to a rounded value, and rounding an offset silently moves the page — and not
 * a bound on how many keys a workspace may have. A ceiling of the latter kind
 * fails the wrong way: an offset above it falls back to 0, so the last page of
 * a roster past the ceiling would answer Next by jumping to the first.
 */
const OFFSET = /^(0|[1-9][0-9]{0,15})$/;

type Params = Readonly<Record<string, string | string[] | undefined>>;

/** The offset a query asked for, or 0 for one this page cannot read. */
function readOffset(raw: string | undefined): number {
  if (raw === undefined || !OFFSET.test(raw)) return 0;
  const offset = Number(raw);
  return Number.isSafeInteger(offset) ? offset : 0;
}

export function parseApiKeysView(params: Params): ApiKeysView {
  const rawShow = firstParam(params.show);
  return {
    workspace: firstParam(params.workspace),
    show: API_KEYS_SHOW.find((s) => s === rawShow) ?? "active",
    offset: readOffset(firstParam(params.offset)),
  };
}

/**
 * The route for a view. The defaults — the active keys, the first page — are
 * left off the query, so the plain link to the page is the plain link to the
 * page however a person arrived at it.
 */
export function apiKeysLink(
  org: string,
  to: { workspace: string; show?: ApiKeysShow; offset?: number },
): SafePath {
  return routes.apiKeys(org, {
    workspace: to.workspace,
    show: to.show === undefined || to.show === "active" ? undefined : to.show,
    offset:
      to.offset === undefined || to.offset === 0
        ? undefined
        : String(to.offset),
  });
}

/** The keys this filter keeps, in the order the read returned them. */
export function filterKeys(
  keys: readonly ApiKey[],
  show: ApiKeysShow,
): readonly ApiKey[] {
  return show === "all" ? keys : keys.filter((key) => key.revokedAt === null);
}

export type ApiKeysPage = {
  /** The rows this page shows. */
  rows: readonly ApiKey[];
  /** The offset they actually start at, which is not always the one asked for. */
  offset: number;
  /** How many rows the filter kept, across every page. */
  total: number;
};

/**
 * One page of a filtered roster. The offset is clamped to a page that exists:
 * revoking the last key on the last page, or narrowing the filter from a deep
 * page, otherwise answers an out-of-range offset with an empty table and no way
 * back except editing the URL. Clamping lands on the last page instead, and the
 * pager it is handed then agrees with the rows beside it.
 */
export function pageOfKeys(
  kept: readonly ApiKey[],
  offset: number,
): ApiKeysPage {
  const total = kept.length;
  const lastPageStart =
    total === 0 ? 0 : Math.floor((total - 1) / API_KEYS_PAGE) * API_KEYS_PAGE;
  const start = Math.min(Math.max(offset, 0), lastPageStart);
  return {
    rows: kept.slice(start, start + API_KEYS_PAGE),
    offset: start,
    total,
  };
}
