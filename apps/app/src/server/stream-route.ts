// GET /api/mc/{org}/{ws}/stream: the one live-data route (plan §4.9).
//
//   ?run=<public id>  frames of that run   (event: frame)
//   (no run)          fleet row patches    (event: patch)
//   Last-Event-ID / ?after=<run_seq>        resume cursor (Last-Event-ID wins)
//
// The same membership gate as every page: a signed-out request is 401, a
// stranger or unknown slug 404 (never a hint the org exists), an overdue MFA
// enrollment 403, a renamed slug 308 to the canonical stream URL. A failed read
// streams one `event: state` carrying the Read failure, then closes, so the
// page renders not_backed / denied / error exactly as it would server-side.
import "server-only";
import { AppError } from "./errors";
import { isFixtureMode } from "./fixture-session";
import {
  SSE_HEADERS,
  type StreamTimings,
  createCursorStream,
  resolveStreamCursor,
} from "./sse";
import type { StreamFeeds } from "./stream-feeds";
import {
  canonicalPath,
  type Viewer,
  type ViewerResolution,
} from "./viewer-resolution";

/** A run public id (`arun_…`). Anything else is refused before a read. */
const RUN_ID = /^[a-z]+_[A-Za-z0-9]+$/;

/** Frames or patches per read; bounds one poll's work and one flush's size. */
export const STREAM_PAGE_SIZE = 200;

function json(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

/** The Response for a request requireViewer would have interrupted. */
export function viewerFailureResponse(
  result: Exclude<ViewerResolution, { kind: "ok" }>,
  req: Request,
  params: { org: string; ws: string },
): Response {
  switch (result.kind) {
    case "unauthenticated":
      return json(401, { code: "unauthenticated" });
    case "not_found":
      return json(404, { code: "not_found" });
    case "mfa_enroll":
      return json(403, { code: "mfa_enrollment_required" });
    case "redirect": {
      const url = new URL(req.url);
      const location = canonicalPath({
        pathname: url.pathname,
        search: url.search,
        base: "/api/mc/",
        from: { org: params.org, ws: params.ws },
        to: { org: result.org, ws: result.ws },
      });
      return new Response(null, {
        status: 308,
        headers: { location, "cache-control": "no-store" },
      });
    }
  }
}

export type StreamRouteDeps = {
  resolveViewer: (org: string, ws: string) => Promise<ViewerResolution>;
  feeds: () => Promise<StreamFeeds>;
  onError?: (error: unknown) => void | Promise<void>;
  /** Test seam for the stream timings; production uses STREAM_DEFAULTS. */
  timings?: Partial<StreamTimings>;
};

export async function handleStreamRequest(
  req: Request,
  params: { org: string; ws: string },
  deps: StreamRouteDeps,
): Promise<Response> {
  const resolution = await deps.resolveViewer(params.org, params.ws);
  if (resolution.kind !== "ok")
    return viewerFailureResponse(resolution, req, params);
  const viewer: Viewer = resolution.viewer;

  const url = new URL(req.url);
  const runId = url.searchParams.get("run");
  if (runId !== null && !RUN_ID.test(runId))
    return json(400, { code: "invalid_run_id" });

  let cursor: string;
  try {
    cursor = resolveStreamCursor(
      req.headers.get("last-event-id"),
      url.searchParams.get("after"),
    );
  } catch (error) {
    if (error instanceof AppError)
      return json(error.status, { code: error.code });
    throw error;
  }

  const feeds = await deps.feeds();
  const { scope } = viewer;
  const body = createCursorStream({
    ...deps.timings,
    cursor,
    signal: req.signal,
    event: runId === null ? "patch" : "frame",
    ...(deps.onError ? { onError: deps.onError } : {}),
    read:
      runId === null
        ? (after) => feeds.fleetSince(scope, after, STREAM_PAGE_SIZE)
        : (after) => feeds.framesSince(scope, runId, after, STREAM_PAGE_SIZE),
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/**
 * Report a read that threw mid-stream. The route catches it to send an error
 * state, so onRequestError never sees it; this is its capture point. Telemetry
 * is imported lazily: fixture mode has no ClickHouse to write to.
 */
export async function reportStreamError(error: unknown): Promise<void> {
  if (isFixtureMode()) {
    console.error("mc stream read failed", error);
    return;
  }
  try {
    const { captureError } = await import("@oxagen/telemetry");
    captureError({
      error,
      source: "app",
      severity: "error",
      context: "mc stream read failed",
    });
  } catch {
    // Error capture must never become a new failure at the boundary.
  }
}
