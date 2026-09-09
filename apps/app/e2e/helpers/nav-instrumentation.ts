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

/**
 * What one `window.fetch` call is asking for, decided without touching the
 * network.
 *
 * `fetch` accepts three kinds of first argument — a string, a `URL`, or a
 * `Request` — and this used to read `.url` off whichever one arrived. A `URL`
 * has no `.url`, so a caller passing one got `undefined`, and the very next
 * line called `.includes` on it. The diagnostic then threw inside the app's
 * own fetch, before the real request was ever made.
 *
 * That is what broke signup in the two specs carrying this instrumentation:
 * Better Auth's client passes a `URL`, so `signUp.email` rejected with
 * "Cannot read properties of undefined (reading 'includes')", the form
 * rendered it, no request left the browser, and the spec reported only a
 * navigation timeout. Nightly run 34185226553 is the specimen — its trace
 * holds 50 requests and not one POST.
 *
 * Exported, self-contained, and free of imports and closures for two reasons:
 * a unit test drives it directly, and `installNavInstrumentation` serializes
 * it into the page with `toString()`. One copy, checked where it is cheap to
 * check. Anything it cannot classify is reported as not-RSC with an empty
 * url, which makes the caller pass the request straight through.
 */
export function classifyFetchInput(
  input: unknown,
  init: unknown,
): { url: string; isRscLike: boolean } {
  let url = "";
  try {
    if (typeof input === "string") {
      url = input;
    } else if (input !== null && typeof input === "object") {
      const asUrl = (input as { href?: unknown }).href;
      const asRequest = (input as { url?: unknown }).url;
      if (typeof asUrl === "string") url = asUrl;
      else if (typeof asRequest === "string") url = asRequest;
    }
  } catch {
    url = "";
  }

  let isRscLike = url.indexOf("_rsc=") !== -1;
  try {
    const fromInit = (init as { headers?: unknown } | null | undefined)
      ?.headers;
    const fromInput = (input as { headers?: unknown } | null | undefined)
      ?.headers;
    const source = fromInit ?? fromInput;
    if (source !== undefined && source !== null) {
      const headers = new Headers(source as HeadersInit);
      isRscLike =
        isRscLike ||
        headers.get("RSC") === "1" ||
        headers.get("Next-Router-State-Tree") !== null;
    }
  } catch {
    // A header bag this cannot read says nothing about the request, and must
    // not decide anything: the url check above stands on its own.
  }

  return { url, isRscLike };
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

  // Built as script text rather than passed as a function so the classifier
  // above can be shared with its unit test instead of copied into the page.
  // Playwright serializes an addInitScript function to source either way.
  //
  // Runs before any application JS on every document the page loads
  // (including the post-signup navigation), not just the current one.
  void page.addInitScript({
    content: `
(() => {
  const classifyFetchInput = ${classifyFetchInput.toString()};

  const emit = (line) => {
    console.log("__NAV_INSTRUMENT__ " + line);
  };

  const origPush = history.pushState.bind(history);
  history.pushState = function patchedPushState(...args) {
    emit("history.pushState -> " + String(args[2]));
    return origPush(...args);
  };

  const origReplace = history.replaceState.bind(history);
  history.replaceState = function patchedReplaceState(...args) {
    emit("history.replaceState -> " + String(args[2]));
    return origReplace(...args);
  };

  window.addEventListener("unhandledrejection", (ev) => {
    emit("unhandledrejection: " + String(ev.reason));
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    // Observation must never break the call being observed. Anything this
    // wrapper cannot work out about the request hands it straight to the
    // real fetch, unwatched, rather than throwing into the app.
    let target;
    try {
      target = classifyFetchInput(args[0], args[1]);
    } catch (classifyErr) {
      return origFetch(...args);
    }
    if (!target.isRscLike) return origFetch(...args);

    const url = target.url;
    emit("fetch(rsc) start " + url);
    try {
      const res = await origFetch(...args);
      emit("fetch(rsc) headers " + url + " -> " + res.status);
      try {
        // Read a clone so the app's own consumer still gets a fresh,
        // unconsumed body/stream.
        await res.clone().text();
        emit("fetch(rsc) body ok " + url);
      } catch (bodyErr) {
        emit("fetch(rsc) body ERROR " + url + ": " + String(bodyErr));
      }
      return res;
    } catch (err) {
      emit("fetch(rsc) ERROR " + url + ": " + String(err));
      throw err;
    }
  };
})();
`,
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
