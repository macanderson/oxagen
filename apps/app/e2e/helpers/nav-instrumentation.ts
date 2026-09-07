/**
 * nav-instrumentation.ts — diagnostic capture for the #2559 nav-click race.
 *
 * The existing Playwright trace for that failure (run 34032000612) already
 * rules out four things from the network/DOM layer: the click lands on the
 * right element, the href matches the awaited URL, the destination RSC
 * fetch returns 200, and the page simply never moves off the list view. What
 * it cannot answer is whether the App Router's click handler ran at all and
 * failed to commit the navigation, or never ran — because a Playwright trace
 * does not capture the app's own console output, and nothing in the app logs
 * to console about a navigation today.
 *
 * This installs three independent signals, all recorded as ordinary console
 * lines so they land in Playwright's trace (and in `logs` for direct
 * inspection/attachment) without needing a custom reporter:
 *
 *   1. history.pushState/replaceState, patched before any app code runs.
 *      The App Router only calls one of these once a client-side navigation
 *      has resolved its RSC payload and is ready to commit. A click that
 *      logs neither ran the handler and never got past starting the
 *      transition; a click that logs one and the URL still doesn't move is
 *      a different bug entirely (something is committing history without
 *      the page reflecting it).
 *   2. window.fetch, wrapped to recognize the App Router's RSC/flight
 *      requests (the `RSC: 1` / `Next-Router-State-Tree` request headers,
 *      or a `_rsc=` query param — the only stable signals across Next
 *      versions; there is no public API for this). Each is logged at the
 *      header-response stage AND after actually reading the body. A request
 *      can report `200 OK` and still fail while the stream is read — which
 *      is exactly what a server-side render exception raised mid-stream
 *      (e.g. the PPR "postponed state" invariant this issue's comments
 *      already logged nearby in time) would look like from the network tab
 *      alone. The existing trace only ever inspected the header-level
 *      status.
 *   3. `unhandledrejection` and Playwright's own `pageerror`/`requestfailed`
 *      events, in case the router's internal fetch is rejected somewhere
 *      that surfaces as an uncaught promise rather than a caught one.
 *
 * Call `installNavInstrumentation(page)` once per test, before the
 * navigation under test. Attach `.logs` to the test report unconditionally
 * (see `attachNavLogs`) so a nightly failure captures the answer without
 * needing a local `--debug` session.
 */
import type { Page, TestInfo } from "@playwright/test";

const NAV_TAG = "__NAV_INSTRUMENT__ ";

export interface NavInstrumentation {
  /** Every captured diagnostic line, in wall-clock order. */
  readonly logs: string[];
}

export function installNavInstrumentation(page: Page): NavInstrumentation {
  const logs: string[] = [];

  page.on("console", (msg) => {
    const text = msg.text();
    logs.push(
      text.startsWith(NAV_TAG)
        ? text.slice(NAV_TAG.length)
        : `[console.${msg.type()}] ${text}`,
    );
  });
  page.on("pageerror", (err) => {
    logs.push(`[pageerror] ${err.stack ?? err.message}`);
  });
  page.on("requestfailed", (req) => {
    logs.push(
      `[requestfailed] ${req.method()} ${req.url()} — ${
        req.failure()?.errorText ?? "unknown"
      }`,
    );
  });

  // Installed via addInitScript so it runs before any application JS on
  // every document the page loads (including the post-signup navigation),
  // not just the current one.
  void page.addInitScript(() => {
    const emit = (line: string) => {
      console.log(`__NAV_INSTRUMENT__ ${line}`);
    };

    const origPush = history.pushState.bind(history);
    history.pushState = function patchedPushState(
      ...args: Parameters<typeof origPush>
    ) {
      emit(`history.pushState -> ${String(args[2])}`);
      return origPush(...args);
    };

    const origReplace = history.replaceState.bind(history);
    history.replaceState = function patchedReplaceState(
      ...args: Parameters<typeof origReplace>
    ) {
      emit(`history.replaceState -> ${String(args[2])}`);
      return origReplace(...args);
    };

    window.addEventListener("unhandledrejection", (ev) => {
      emit(
        `unhandledrejection: ${String((ev as PromiseRejectionEvent).reason)}`,
      );
    });

    const origFetch = window.fetch.bind(window);
    window.fetch = async (
      ...args: Parameters<typeof origFetch>
    ): ReturnType<typeof origFetch> => {
      const [input, init] = args;
      const url = typeof input === "string" ? input : (input as Request).url;
      const reqForHeaders = input instanceof Request ? input : undefined;
      const headers = new Headers(init?.headers ?? reqForHeaders?.headers);
      const isRscLike =
        headers.get("RSC") === "1" ||
        headers.get("Next-Router-State-Tree") != null ||
        url.includes("_rsc=");
      if (!isRscLike) return origFetch(...args);

      emit(`fetch(rsc) start ${url}`);
      try {
        const res = await origFetch(...args);
        emit(`fetch(rsc) headers ${url} -> ${res.status}`);
        try {
          // Read a clone so the app's own consumer still gets a fresh,
          // unconsumed body/stream.
          await res.clone().text();
          emit(`fetch(rsc) body ok ${url}`);
        } catch (bodyErr) {
          emit(`fetch(rsc) body ERROR ${url}: ${String(bodyErr)}`);
        }
        return res;
      } catch (err) {
        emit(`fetch(rsc) ERROR ${url}: ${String(err)}`);
        throw err;
      }
    };
  });

  return { logs };
}

/**
 * Attach the captured lines to the current test's report, unconditionally
 * (not just on failure) so a run that *doesn't* reproduce the race still
 * shows what a clean navigation's signal looks like for comparison. Safe to
 * call more than once per test with a distinct `label` (e.g. once per
 * sidebar navigation).
 */
export async function attachNavLogs(
  testInfo: TestInfo,
  instrumentation: NavInstrumentation,
  label: string,
): Promise<void> {
  await testInfo.attach(`nav-instrumentation-${label}`, {
    body: instrumentation.logs.join("\n") || "(no diagnostic lines captured)",
    contentType: "text/plain",
  });
}
