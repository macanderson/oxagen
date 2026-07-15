/**
 * flags.ts — minimal feature-flag seam for apps/app.
 *
 * There is deliberately no flag SDK here: a flag is an env default
 * (`NEXT_PUBLIC_*`, inlined at build time) with an optional per-browser cookie
 * override so a flag can be flipped on for one session in any environment
 * without a redeploy. Server components resolve the flag ONCE (env + cookie)
 * and pass the boolean down as a prop — client code never re-derives it, so
 * server and client can't disagree mid-render.
 */

/** Cookie name for the chat UX v2 override (`1` = on, `0` = force off). */
export const CHAT_UX_V2_COOKIE = "chat_ux_v2";

/**
 * Resolve the `chat_ux_v2` flag. Default OFF. Precedence:
 *   1. Cookie override ("1" on / "0" off) — set manually or via
 *      `?chat_ux_v2=1` (see proxy.ts) for per-browser QA.
 *   2. `NEXT_PUBLIC_CHAT_UX_V2=1` — environment-wide default.
 *
 * Pass the raw cookie value (or undefined) from the caller: server components
 * read it via `cookies()`, tests pass a literal.
 */
export function chatUxV2Enabled(cookieValue?: string | null): boolean {
  if (cookieValue === "1") return true;
  if (cookieValue === "0") return false;
  return process.env.NEXT_PUBLIC_CHAT_UX_V2 === "1";
}
