import type { Page, Route } from "@playwright/test";
import type { StreamEvent } from "../../src/components/chat/stream-event-types";

export interface InterceptOptions {
  events: StreamEvent[];
  /** Delay between events in milliseconds. Defaults to 80ms. */
  delayMs?: number;
  /** URL glob to intercept. Defaults to the chat send endpoint. */
  urlGlob?: string;
  /**
   * Hold the post-turn RSC refresh so the streamed (live) bubbles stay visible
   * for assertions. Defaults to true.
   *
   * Why: after a turn the chat shell fires router.refresh() to reconcile the
   * live SSE state against the now-persisted assistant reply. The mock
   * intercepts the SSE stream but cannot persist a reply to Postgres, so the
   * refresh re-renders the conversation from the DB (user message only) and the
   * [messages] effect reset()s the streamed bubbles — wiping the very cards/text
   * the spec asserts on (a race that flakes). Holding the RSC GET keeps the live
   * state in place for the test. The initial page.goto is a full-document load
   * (no RSC header), so navigation is unaffected.
   */
  holdRefresh?: boolean;
  /**
   * Let the first-turn `router.replace(pathname + "?c=" + publicId)` soft
   * navigation through the hold so the conversation id can commit into the
   * URL. Defaults to FALSE — and must stay false for any spec that asserts
   * streamed content (cards, inline forms, lock state) after the first send:
   * in the mocked world the assistant reply is never persisted server-side,
   * so letting the navigation's RSC fetch through re-renders the page from
   * the DB and races the streamed client state away (nondeterministic across
   * CI runs). Opt in ONLY when the spec needs `?c=` in the URL and does NOT
   * rely on streamed state surviving the navigation (it should reload right
   * after, like conversation-files-zip.spec.ts).
   */
  allowConversationNavigation?: boolean;
}

// Intercept the chat-stream POST and return a deterministic SSE response
// that yields the supplied events in order with realistic inter-event
// delays. We also intercept upstream LLM calls so the runtime never reaches
// Anthropic / any provider during the test.
export async function interceptAgentStream(
  page: Page,
  opts: InterceptOptions,
): Promise<void> {
  const delayMs = opts.delayMs ?? 80;
  const urlGlob = opts.urlGlob ?? "**/api/v1/chat/stream";

  // Disable CSS animations and the rAF-based StreamingText reveal so that
  // streamed text is immediately readable in the DOM without waiting for
  // animation frames. The MotionProvider wraps motion/react with
  // reducedMotion="user", so emulating prefers-reduced-motion:reduce causes
  // useReducedMotion() to return true — StreamingText renders the full
  // accumulated text in its first paint instead of counting up from 0.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.route("**/api/anthropic/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, mocked: true }),
    }),
  );

  await page.route(urlGlob, async (route: Route) => {
    const chunks: string[] = [];
    for (const ev of opts.events) {
      chunks.push(`data: ${JSON.stringify(ev)}\n\n`);
    }
    chunks.push("event: done\ndata: [DONE]\n\n");

    // Concatenate into a single SSE body. Ordering, not per-event pacing, is
    // what the specs assert on, so we wait once before responding to emulate
    // end-to-end stream latency in a deterministic way.
    await new Promise((r) => setTimeout(r, delayMs));

    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: chunks.join(""),
    });
  });

  if (opts.holdRefresh ?? true) {
    // Hold the post-turn RSC refresh of the conversation page so the live
    // streamed bubbles persist through the assertions (see holdRefresh docs).
    // Match only RSC GETs (header `rsc: 1`) to the conversation route; the
    // full-document page.goto has no RSC header and falls through to continue().
    //
    // The route is /sessions — `/ask` and `/chat` are 301 shims onto it
    // (src/proxy.ts WS_RENAMES, the Ask→Sessions rename). Matching the two
    // shims alone held nothing: every spec lands on /sessions, whether it
    // navigates there or is redirected, so the post-turn reconcile ran and
    // reset() wiped the streamed bubbles before the assertions read them.
    // All three are matched so a spec still on a legacy path behaves the same.
    //
    // On a conversation's FIRST turn, chat-shell-client.tsx also calls
    // `router.replace(pathname + "?c=" + publicId)` to pin the new
    // conversation id into the URL — that replace() is itself an RSC GET to
    // this exact same route (a soft navigation needs its target's RSC
    // payload before it will commit the new URL via history.replaceState).
    // Holding THAT request indiscriminately (the original regex-only match)
    // stalls the navigation forever: the browser's address bar never gains
    // `?c=`, even though the mocked stream still completes and renders (a
    // deterministic hang, not a flake — see conversation-files-zip.spec.ts).
    //
    // Distinguish the two by comparing the request's LOGICAL url (pathname +
    // search, minus Next's own `_rsc=<hash>` cache-busting param it appends
    // to every RSC fetch) against the page's CURRENTLY COMMITTED url:
    // router.replace() targets a url that differs from page.url();
    // router.refresh() re-fetches the url the page is ALREADY on.
    //
    // BOTH are held by default. Letting the navigation through commits `?c=`
    // but its RSC payload re-renders the page from the DB — which, under this
    // mock, holds no assistant reply — racing away the streamed client state
    // (cards, inline forms, composer locks) that most specs assert on. Only
    // a spec that opted in via `allowConversationNavigation` (because it
    // needs the URL and reloads right after) gets the navigation through.
    const logicalUrl = (raw: string): string => {
      const u = new URL(raw);
      u.searchParams.delete("_rsc");
      return `${u.pathname}${u.search}`;
    };
    await page.route(
      (url) =>
        /\/(sessions|ask|chat)(\?|$)/.test(`${url.pathname}${url.search}`),
      async (route: Route) => {
        const req = route.request();
        const isSameUrlRefresh =
          logicalUrl(req.url()) === logicalUrl(page.url());
        const isHeldNavigation =
          !isSameUrlRefresh && !(opts.allowConversationNavigation ?? false);
        if (
          req.method() === "GET" &&
          req.headers()["rsc"] === "1" &&
          (isSameUrlRefresh || isHeldNavigation)
        ) {
          // Never fulfill: the refresh stays pending, so the [messages]
          // reconcile that would reset() the streamed bubbles never fires.
          return;
        }
        await route.continue();
      },
    );
  }
}
