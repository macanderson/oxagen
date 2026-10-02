// The Memories tab's two writes through the real kernel seam (#4914). The
// viewer resolution and the kernel's invoke() are the only fakes, so each
// case shows what the tab gets back and whether the capability ran: ok,
// invalid (refused before the kernel), denied for a role that cannot write,
// and conflict with the handler's reason.
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

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { dismissMemories, promoteMemories } = await import("./actions");

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

/** The CapabilityContext every call reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

const DRAFT = {
  memory_ids: ["mem_01k5rw3draft"],
  statement: "Open every release as a draft.",
  kind: "procedure" as const,
  force: "should" as const,
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("promoteMemories", () => {
  it("adds the drafts to the memory PR for the workspace viewer and counts what landed", async () => {
    invoke.mockResolvedValue({
      pull_request: {
        number: 59,
        url: "https://github.com/acme/oxagen-core-platform/pull/59",
        branch: "memory/2026-10-01",
        opened: false,
      },
      records: [
        {
          path: "steering/memory/release/core.release.draft-releases.md",
          lineage: "core.release.draft-releases",
          kind: "procedure",
          force: "should",
          effect: null,
          memory_ids: ["mem_01k5rw3draft"],
        },
      ],
      skipped: [{ memory_id: "mem_01k5rw3other", reason: "not_waiting" }],
    });
    expect(await promoteMemories("acme", "core-platform", [DRAFT])).toEqual({
      ok: true,
      value: {
        pullRequest: {
          number: 59,
          url: "https://github.com/acme/oxagen-core-platform/pull/59",
          opened: false,
        },
        records: 1,
        skipped: 1,
      },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "promote_memories",
      expect.objectContaining({ drafts: [DRAFT], same_text: true }),
      expect.objectContaining(TENANT),
    );
  });

  it("says no memory PR when every draft was left out", async () => {
    invoke.mockResolvedValue({
      pull_request: null,
      records: [],
      skipped: [{ memory_id: "mem_01k5rw3draft", reason: "already_proposed" }],
    });
    expect(await promoteMemories("acme", "core-platform", [DRAFT])).toEqual({
      ok: true,
      value: { pullRequest: null, records: 0, skipped: 1 },
    });
  });

  it("refuses a constraint with no effect before the kernel runs (negative)", async () => {
    const result = await promoteMemories("acme", "core-platform", [
      { ...DRAFT, kind: "constraint" },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers denied for a role that cannot promote (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    expect(await promoteMemories("acme", "core-platform", [DRAFT])).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("answers conflict with the handler's reason when no steering repo is set up (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "steering_repo_required",
      }),
    );
    expect(await promoteMemories("acme", "core-platform", [DRAFT])).toEqual({
      ok: false,
      reason: "conflict",
      code: "steering_repo_required",
    });
  });
});

describe("dismissMemories", () => {
  it("dismisses the memories and counts what changed", async () => {
    invoke.mockResolvedValue({
      changed: ["mem_01k5rw3draft"],
      skipped: [],
      rejections: 1,
    });
    expect(
      await dismissMemories(
        "acme",
        "core-platform",
        ["mem_01k5rw3draft"],
        false,
      ),
    ).toEqual({ ok: true, value: { changed: 1, skipped: 0 } });
    expect(invoke).toHaveBeenCalledWith(
      "dismiss_memories",
      expect.objectContaining({
        memory_ids: ["mem_01k5rw3draft"],
        restore: false,
      }),
      expect.objectContaining(TENANT),
    );
  });

  it("restores a dismissed memory with restore", async () => {
    invoke.mockResolvedValue({
      changed: ["mem_01k5rw3draft"],
      skipped: [],
      rejections: 1,
    });
    await dismissMemories("acme", "core-platform", ["mem_01k5rw3draft"], true);
    expect(invoke).toHaveBeenCalledWith(
      "dismiss_memories",
      expect.objectContaining({ restore: true }),
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an id that is not a memory's before the kernel runs (negative)", async () => {
    const result = await dismissMemories(
      "acme",
      "core-platform",
      ["prp_01k5ru4a"],
      false,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers denied for a role that cannot dismiss (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    expect(
      await dismissMemories(
        "acme",
        "core-platform",
        ["mem_01k5rw3draft"],
        false,
      ),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });
});
