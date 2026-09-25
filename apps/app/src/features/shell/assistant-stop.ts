// The flyout's Stop control: `POST /{org}/{ws}/assistant/stop` with
// `{ turnId }` (#4164).
//
// It is a route and not a server action because the actions of one page run
// one at a time. A stop sent as an action would wait behind any action still
// pending, and it has to reach the turn while the turn streams
// (`assistant-stream-client.ts`), before the turn finishes on its own.
//
// The gates run in order. The request must be JSON, which a form on another
// site cannot send without a preflight this route never answers. The viewer
// must be signed in and a member of the workspace, and a stranger is told
// `not_found`, the answer a workspace that does not exist gets. Then
// `stopAssistantTurn` asks `cancel_assistant_turn`, which matches the turn on
// the person as well as the id, so nobody can stop a turn they did not ask.
//
// Closing the flyout never posts here: a turn the person walks away from runs
// to its end (ADR-092, #3292).
import "server-only";
import type { ActionResult } from "@/server/kernel";
import type { WsRouteViewer } from "@/server/viewer";
import { responseRedirect } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";

export type AssistantStopDeps = {
  resolveViewer: (org: string, ws: string) => Promise<WsRouteViewer>;
  stopTurn: (
    org: string,
    ws: string,
    turnId: string,
  ) => Promise<ActionResult<{ turnId: string; found: boolean }>>;
};

/** The shape of a turn id. The contract checks it again. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(status: number, code: string): Response {
  return Response.json({ code }, { status });
}

/** The `turnId` of a JSON body, or null when the body carries no valid one. */
async function turnIdOf(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || !("turnId" in body)) {
    return null;
  }
  const { turnId } = body;
  return typeof turnId === "string" && UUID.test(turnId) ? turnId : null;
}

export async function handleAssistantStop(
  request: Request,
  context: { params: Promise<{ org: string; ws: string }> },
  deps: AssistantStopDeps,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return refusal(415, "unsupported_media_type");
  }
  const { org, ws } = await context.params;
  const viewer = await deps.resolveViewer(org, ws);
  switch (viewer.kind) {
    case "unauthenticated":
      return refusal(401, "unauthenticated");
    case "not_found":
      return refusal(404, "not_found");
    case "mfa_enroll":
      return refusal(403, "mfa_required");
    case "sso_required":
      return refusal(403, "sso_required");
    // The page was reached by a slug the organization or workspace used to
    // have. A 308 keeps the method and the body, so the browser posts the
    // same stop to the current address.
    case "redirect":
      return responseRedirect(
        request,
        routes.assistantStop(viewer.org, viewer.ws ?? ws),
        308,
      );
    case "ok":
      break;
  }

  const turnId = await turnIdOf(request);
  if (turnId === null) return refusal(400, "invalid");

  const stopped = await deps.stopTurn(org, ws, turnId);
  if (stopped.ok) return Response.json(stopped.value);
  if (stopped.reason === "denied") return refusal(403, "denied");
  if (stopped.reason === "invalid") return refusal(400, "invalid");
  if (stopped.reason === "not_found") return refusal(404, "not_found");
  return refusal(503, "unavailable");
}
