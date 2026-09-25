// The flyout's thread read (#4163): the viewer resolved from the slugs in the
// URL, the conversations port read with that viewer, and the workspace's
// stable id answered beside the thread so a rename cannot strand it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, latest } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  latest: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));
vi.mock("@/data/source", () => ({
  dataSource: () => ({ conversations: { latest } }),
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { loadAssistantThread } = await import("./assistant-thread-actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const THREAD = {
  id: "cnv_01k9x2",
  messages: [
    {
      id: "msg_a1",
      role: "user" as const,
      text: "what is live?",
      runId: null,
      parked: [],
    },
  ],
  truncated: false,
};

beforeEach(() => {
  requireViewer.mockReset();
  latest.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("loadAssistantThread", () => {
  it("reads the viewer's latest thread in the workspace the slugs name, keyed by the workspace's id", async () => {
    latest.mockResolvedValue(readOk(THREAD));
    const result = await loadAssistantThread("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(latest).toHaveBeenCalledWith(ctx);
    expect(result).toEqual({
      ok: true,
      value: { workspaceKey: ctx.workspaceId, thread: THREAD },
    });
  });

  it("answers a null thread for a viewer with no conversation yet", async () => {
    latest.mockResolvedValue(readOk(null));
    const result = await loadAssistantThread("acme", "core-platform");
    expect(result).toEqual({
      ok: true,
      value: { workspaceKey: ctx.workspaceId, thread: null },
    });
  });

  it("carries a refused read out as an ActionResult (negative)", async () => {
    latest.mockResolvedValue(readError("control_plane_unavailable", 503));
    const result = await loadAssistantThread("acme", "core-platform");
    expect(result.ok).toBe(false);
  });
});
