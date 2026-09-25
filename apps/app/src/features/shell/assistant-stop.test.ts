// The flyout's Stop route over its two seams: the viewer resolution and the
// stop action. The route decides who may stop and what the browser is told;
// which turn stops is the kernel's business (`cancel_assistant_turn`).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsCtx, type WsRouteViewer } from "@/server/viewer";
import { unsafeMint } from "@/server/viewer.testing";
import { handleAssistantStop } from "./assistant-stop";

const TURN_ID = "0192d4a8-7c1e-7a00-8000-0000000000f1";

const resolveViewer =
  vi.fn<(org: string, ws: string) => Promise<WsRouteViewer>>();
const stopTurn = vi.fn();

/** A member of acme's core-platform. The handler switches on `kind` and never
 *  reads `ctx`, but the type asks for one, so it is minted rather than asserted. */
const OK_VIEWER: WsRouteViewer = {
  kind: "ok",
  ctx: unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: "member",
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole: "member",
  }),
};

function call(
  body: string = JSON.stringify({ turnId: TURN_ID }),
  contentType: string | null = "application/json",
) {
  const headers = new Headers();
  if (contentType !== null) headers.set("content-type", contentType);
  return handleAssistantStop(
    new Request("https://app.example/acme/core-platform/assistant/stop", {
      method: "POST",
      headers,
      body,
    }),
    { params: Promise.resolve({ org: "acme", ws: "core-platform" }) },
    { resolveViewer, stopTurn },
  );
}

beforeEach(() => {
  resolveViewer.mockReset();
  resolveViewer.mockResolvedValue(OK_VIEWER);
  stopTurn.mockReset();
  stopTurn.mockResolvedValue({
    ok: true,
    value: { turnId: TURN_ID, found: true },
  });
});

describe("the stop", () => {
  it("stops the named turn in the workspace and says it found it", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ turnId: TURN_ID, found: true });
    expect(resolveViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(stopTurn).toHaveBeenCalledWith("acme", "core-platform", TURN_ID);
  });

  // A turn that already ended, or another person's, is found: false. That is
  // an answer, not a failure: the flyout has nothing left to stop.
  it("answers found false for a turn that is not running", async () => {
    stopTurn.mockResolvedValue({
      ok: true,
      value: { turnId: TURN_ID, found: false },
    });
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ turnId: TURN_ID, found: false });
  });
});

describe("the gates", () => {
  it("refuses a body that is not JSON and asks nobody (negative)", async () => {
    const response = await call(`turnId=${TURN_ID}`, "text/plain");
    expect(response.status).toBe(415);
    expect(resolveViewer).not.toHaveBeenCalled();
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("refuses a signed-out visitor and stops nothing (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "unauthenticated" });
    expect((await call()).status).toBe(401);
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("refuses someone who is not in the workspace with not_found, a 404 (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "not_found" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found" });
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("refuses when two-factor enrolment is owed (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "mfa_enroll" });
    expect((await call()).status).toBe(403);
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("refuses when the organization requires SSO and the session is not one (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "sso_required" });
    expect((await call()).status).toBe(403);
    expect(stopTurn).not.toHaveBeenCalled();
  });

  // A 308 keeps the method and the body, so the browser posts the same stop
  // to the workspace's current address instead of losing it.
  it("sends a stop on a renamed workspace's old slug to its current address", async () => {
    resolveViewer.mockResolvedValue({
      kind: "redirect",
      org: "acme",
      ws: "platform",
    });
    const response = await call();
    expect(response.status).toBe(308);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/acme/platform/assistant/stop",
    );
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("refuses a body with no turn id, or one that is not a uuid (negative)", async () => {
    expect((await call(JSON.stringify({}))).status).toBe(400);
    expect((await call(JSON.stringify({ turnId: "t1" }))).status).toBe(400);
    expect((await call("{not json")).status).toBe(400);
    expect(stopTurn).not.toHaveBeenCalled();
  });
});

describe("the kernel's refusals", () => {
  it("answers 403 when the kernel refuses the person (negative)", async () => {
    stopTurn.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    expect((await call()).status).toBe(403);
  });

  it("answers 503 when the kernel cannot be reached, never a 404 (negative)", async () => {
    stopTurn.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "unavailable",
    });
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable" });
  });
});
