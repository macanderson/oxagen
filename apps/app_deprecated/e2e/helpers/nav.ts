/**
 * nav.ts — resilient workspace navigation for e2e tests.
 *
 * The Next dev server (and the workspace shell's org/workspace resolution +
 * conversation threading) make a plain `page.goto(url)` — which defaults to
 * `waitUntil: "load"` — flaky in CI. Two transient failure modes recur in the
 * shared signup/auth setup, red-flagging unrelated PRs:
 *
 *   - `net::ERR_ABORTED` — the route is still compiling on first hit, or an
 *     in-flight client redirect aborts the `load` the goto is waiting on.
 *   - "interrupted by another navigation" — the workspace route issues a
 *     redirect (e.g. `/{org}/{ws}` → `/{org}/{ws}/ask`, or a conversation
 *     thread redirect) that starts a second navigation before the first's
 *     `load` event fires.
 *
 * `waitUntil: "commit"` resolves as soon as the navigation commits (first
 * response byte, after any server redirect chain), so it is immune to a later
 * redirect/abort of the load event. We then settle to `domcontentloaded`
 * best-effort (a redirect making that throw is harmless — commit already
 * succeeded and callers assert the final URL via Playwright's auto-waiting
 * `toHaveURL`/locator assertions), and retry the whole navigation on the two
 * transient errors, since a cold compile clears within a second or two.
 */
import type { Page } from "@playwright/test";

export async function gotoStable(
  page: Page,
  path: string,
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(path, { waitUntil: "commit", timeout: 30_000 });
      await page
        .waitForLoadState("domcontentloaded", { timeout: 15_000 })
        .catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const transient =
        msg.includes("ERR_ABORTED") ||
        msg.includes("interrupted by another navigation") ||
        msg.includes("Navigation interrupted");
      if (!transient || i === attempts) throw err;
      await page.waitForTimeout(1_000);
    }
  }
  throw lastErr;
}
