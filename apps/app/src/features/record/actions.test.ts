// The record page's one write, through the real viewer and kernel seams: the
// session and the kernel's invoke() are the only fakes, so each case shows
// what `revise_context_record` was asked and what the page gets back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { reviseRecord } = await import("./actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** What `revise_context_record` answers: the Context PR it opened. */
const CONTEXT_PR = {
  proposalId: "prp_rev1",
  lineageId: "ctx.scr.001-never-push-to-main",
  status: "checks_passed",
  governanceMode: "team",
  pr: {
    number: 43,
    url: "https://github.com/acme/platform/pull/43",
    provider: "github",
    repository: "acme/platform",
    baseRef: "main",
    branch: "context/ctx.scr.001-never-push-to-main",
    headSha: "0123456789abcdef",
    path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
  },
  record: null,
  body: null,
  checks: [],
  onMerge: {
    publishes: {
      lineageId: "ctx.scr.001-never-push-to-main",
      path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
    },
    bundleVersion: { current: 3, afterMerge: 4 },
    review: null,
  },
  merged: null,
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("reviseRecord", () => {
  it("revises the record with its statement and reason trimmed, and answers the pull request it opened", async () => {
    invoke.mockResolvedValue(CONTEXT_PR);
    expect(
      await reviseRecord(
        "acme",
        "core-platform",
        "ctx.scr.001-never-push-to-main",
        "  Never push to main.  ",
        "  Main is shared.  ",
      ),
    ).toEqual({
      ok: true,
      value: {
        status: "checks_passed",
        prNumber: 43,
        prUrl: "https://github.com/acme/platform/pull/43",
      },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "revise_context_record",
      {
        recordId: "ctx.scr.001-never-push-to-main",
        statement: "Never push to main.",
        rationale: "Main is shared.",
      },
      expect.objectContaining({ surface: "app" }),
    );
  });

  it("sends no rationale when none was given, and answers a proposal whose pull request is not open yet", async () => {
    invoke.mockResolvedValue({ ...CONTEXT_PR, status: "proposed", pr: null });
    expect(
      await reviseRecord(
        "acme",
        "core-platform",
        "ctx.scr.001-never-push-to-main",
        "Never push to main.",
        "   ",
      ),
    ).toEqual({
      ok: true,
      value: { status: "proposed", prNumber: null, prUrl: null },
    });
    const input: unknown = invoke.mock.calls[0]?.[1];
    expect(input).not.toHaveProperty("rationale");
  });

  it("carries the handler's denial across and changes nothing (negative)", async () => {
    invoke.mockRejectedValue({ code: "authz_denied" });
    expect(
      await reviseRecord(
        "acme",
        "core-platform",
        "ctx.scr.001-never-push-to-main",
        "Never push to main.",
        "",
      ),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});
