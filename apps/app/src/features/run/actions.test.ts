// The run writes through the real kernel seam: the viewer resolution and the
// kernel's invoke() are the only fakes, so each case shows what the person gets
// back and whether the capability ran, ok and denied for every action (INV-19).
//
// Two rules the tests hold the writes to, because breaking either would let the
// interface claim more than the control plane did: a command carries the run as
// its target and nothing wider, and a steer is refused before the kernel when
// its text is empty or past the contract's ceiling.
import { STEER_TEXT_MAX } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
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
const {
  bisectRuns,
  exportRun,
  forkRun,
  haltRun,
  readTranscriptPage,
  steerRun,
  summarizeRun,
} = await import("./actions");

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

const RUN = "tse_7k2m9q";
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};
const denied = (name: string) =>
  new kernel.CapabilityError(name, "authz_denied", "denied");

/**
 * What a handler throws when it refuses: `code: "conflict"` with the refusal
 * named in `reason`. The seam carries that word through as the action's
 * `code`, and the dialog picks its sentence on it, so a test that threw a
 * CapabilityError instead would prove the wrong path.
 */
class HandlerRefusal extends Error {
  readonly code = "conflict";

  constructor(readonly reason: string) {
    super(reason);
    this.name = "HandlerRefusal";
  }
}
const refused = (reason: string) => new HandlerRefusal(reason);

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("haltRun", () => {
  it("queues the command against this run alone and answers the command ids", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_1"] });
    expect(
      await haltRun("acme", "core-platform", RUN, "pause", "releasing 3.2"),
    ).toEqual({ ok: true, value: { commandIds: ["tcm_1"] } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "dispatch_command",
      {
        target: { kind: "run", id: RUN },
        command: "pause",
        reason: "releasing 3.2",
      },
      expect.objectContaining(TENANT),
    );
  });

  it("sends no reason when the field was left blank, rather than an empty one", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_2"] });
    await haltRun("acme", "core-platform", RUN, "cancel", "   ");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      target: { kind: "run", id: RUN },
      command: "cancel",
    });
  });

  it("answers an empty list when no live run took the command (negative)", async () => {
    invoke.mockResolvedValue({ commandIds: [] });
    expect(
      await haltRun("acme", "core-platform", RUN, "resume", "back to it"),
    ).toEqual({ ok: true, value: { commandIds: [] } });
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("dispatch_command"));
    expect(
      await haltRun("acme", "core-platform", RUN, "pause", "stop"),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("steerRun", () => {
  it("sends the trimmed text as the command's payload", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_3"] });
    expect(
      await steerRun("acme", "core-platform", RUN, "  use the 3.2 branch  "),
    ).toEqual({ ok: true, value: { commandIds: ["tcm_3"] } });
    expect(invoke).toHaveBeenCalledWith(
      "dispatch_command",
      {
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "use the 3.2 branch" },
      },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses empty text before the kernel runs (negative)", async () => {
    expect(await steerRun("acme", "core-platform", RUN, "   ")).toEqual({
      ok: false,
      reason: "invalid",
      code: "steer_text",
      field: "text",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses text past the contract's ceiling before the kernel runs (negative)", async () => {
    expect(
      await steerRun(
        "acme",
        "core-platform",
        RUN,
        "x".repeat(STEER_TEXT_MAX + 1),
      ),
    ).toMatchObject({ ok: false, reason: "invalid", code: "steer_text" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("summarizeRun", () => {
  it("queues the summary and answers the run it was queued for", async () => {
    invoke.mockResolvedValue({ runId: RUN, status: "queued" });
    expect(await summarizeRun("acme", "core-platform", RUN)).toEqual({
      ok: true,
      value: { runId: RUN },
    });
    expect(invoke).toHaveBeenCalledWith(
      "summarize_run",
      { runId: RUN },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a refusal on a live run as recorded (negative)", async () => {
    invoke.mockRejectedValue({ code: "conflict", reason: "run_not_sealed" });
    expect(await summarizeRun("acme", "core-platform", RUN)).toMatchObject({
      ok: false,
      reason: "conflict",
      code: "run_not_sealed",
    });
  });
});

describe("exportRun", () => {
  it("queues the bundle and answers its export id", async () => {
    invoke.mockResolvedValue({ exportId: "rexp_1", status: "queued" });
    expect(await exportRun("acme", "core-platform", RUN)).toEqual({
      ok: true,
      value: { exportId: "rexp_1" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "export_run",
      { runId: RUN },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("export_run"));
    expect(await exportRun("acme", "core-platform", RUN)).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

describe("forkRun", () => {
  it("mints the attempt at the frame it was given and answers which attempt it is", async () => {
    invoke.mockResolvedValue({ attemptId: "arat_2", attemptNumber: 2 });
    expect(await forkRun("acme", "core-platform", RUN, "412")).toEqual({
      ok: true,
      value: { attemptId: "arat_2", attemptNumber: 2 },
    });
    expect(invoke).toHaveBeenCalledWith(
      "fork_run",
      { runId: RUN, fromSeq: "412" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a branch point that is not a frame before the kernel sees it (negative)", async () => {
    for (const seq of ["", "  ", "0", "-1", "4.5", "twelve", "9".repeat(20)]) {
      expect(await forkRun("acme", "core-platform", RUN, seq)).toEqual({
        ok: false,
        reason: "invalid",
        code: "from_seq",
        field: "fromSeq",
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's conflict as a conflict, so the dialog can name it (negative)", async () => {
    invoke.mockRejectedValue(refused("replay_grade_below_fork"));
    expect(await forkRun("acme", "core-platform", RUN, "412")).toMatchObject({
      ok: false,
      reason: "conflict",
      code: "replay_grade_below_fork",
    });
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("fork_run"));
    expect(await forkRun("acme", "core-platform", RUN, "412")).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

describe("bisectRuns", () => {
  it("compares this run against the other and answers where they part", async () => {
    invoke.mockResolvedValue({
      divergentSeq: "88",
      keyA: "tool:create_release:ok",
      keyB: "tool:create_release:error",
      aligned: 87,
    });
    expect(
      await bisectRuns("acme", "core-platform", RUN, "  arun_9f2a  "),
    ).toEqual({
      ok: true,
      value: {
        divergentSeq: "88",
        keyA: "tool:create_release:ok",
        keyB: "tool:create_release:error",
        aligned: 87,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "bisect_runs",
      { runA: RUN, runB: "arun_9f2a" },
      expect.objectContaining(TENANT),
    );
  });

  it("carries a null divergence through as recorded, not as an error (negative)", async () => {
    invoke.mockResolvedValue({
      divergentSeq: null,
      keyA: null,
      keyB: null,
      aligned: 431,
    });
    expect(
      await bisectRuns("acme", "core-platform", RUN, "arun_9f2a"),
    ).toEqual({
      ok: true,
      value: { divergentSeq: null, keyA: null, keyB: null, aligned: 431 },
    });
  });

  it("refuses an empty second run, and this run compared with itself, before the kernel (negative)", async () => {
    for (const other of ["", "   ", RUN]) {
      expect(
        await bisectRuns("acme", "core-platform", RUN, other),
      ).toEqual({ ok: false, reason: "invalid", code: "run_b", field: "runB" });
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("readTranscriptPage", () => {
  it("reads the page past the cursor at the zoom and chips it was given", async () => {
    invoke.mockResolvedValue({
      zoom: "steps",
      kinds: ["tools"],
      entries: [],
      cursor: null,
      complete: true,
    });
    const read = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "steps",
      ["tools"],
      "ZjoxMQ",
    );
    expect(read).toEqual({
      ok: true,
      value: {
        zoom: "steps",
        kinds: ["tools"],
        entries: [],
        cursor: null,
        complete: true,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "get_run_transcript",
      {
        runId: RUN,
        zoom: "steps",
        kinds: ["tools"],
        limit: 200,
        after: "ZjoxMQ",
      },
      expect.objectContaining(TENANT),
    );
  });

  it("answers a cursor the capability did not write as a read error, not as a throw (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        "get_run_transcript",
        "invalid_input",
        "invalid_cursor",
      ),
    );
    expect(
      await readTranscriptPage(
        "acme",
        "core-platform",
        RUN,
        "steps",
        [],
        "not-a-cursor",
      ),
    ).toEqual({ ok: false, reason: "error", code: "invalid_input", status: 400 });
  });
});
