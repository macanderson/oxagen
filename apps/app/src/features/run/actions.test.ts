// The run writes through the real kernel seam: the viewer resolution and the
// kernel's invoke() are the only fakes, so each case shows what the person gets
// back and whether the capability ran, ok and denied for every action (INV-19).
//
// Two rules the tests hold the writes to, because breaking either would let the
// interface claim more than the control plane did: a command carries the run as
// its target and nothing wider, and a steer is refused before the kernel when
// its text is empty or past the contract's ceiling.
import {
  COMMAND_REASON_MAX,
  STEER_TEXT_MAX,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import type { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import type { ContractOutput } from "@/server/kernel";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer, captureError } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
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
  readRunExport,
  readTranscriptPage,
  setRunEnrichment,
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

/** The shape `get_run_transcript` answers with, so a fixture cannot drift from it. */
type TranscriptOutput = ContractOutput<typeof runTranscriptGet>;

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
  captureError.mockReset();
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
  it("sends the trimmed text and the delivery mode as the command's payload", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_3"] });
    expect(
      await steerRun(
        "acme",
        "core-platform",
        RUN,
        "  use the 3.2 branch  ",
        "next_step",
      ),
    ).toEqual({ ok: true, value: { commandIds: ["tcm_3"] } });
    expect(invoke).toHaveBeenCalledWith(
      "dispatch_command",
      {
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "use the 3.2 branch", requestedMode: "next_step" },
      },
      expect.objectContaining(TENANT),
    );
  });

  it("carries a mode other than the default through to the command", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_4"] });
    await steerRun("acme", "core-platform", RUN, "stop", "turn_boundary");
    expect(invoke).toHaveBeenCalledWith(
      "dispatch_command",
      expect.objectContaining({
        payload: { text: "stop", requestedMode: "turn_boundary" },
      }),
      expect.objectContaining(TENANT),
    );
  });

  it("refuses empty text before the kernel runs (negative)", async () => {
    expect(
      await steerRun("acme", "core-platform", RUN, "   ", "next_step"),
    ).toEqual({
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
        "next_step",
      ),
    ).toMatchObject({ ok: false, reason: "invalid", code: "steer_text" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a delivery mode outside the contract's three before the kernel runs (negative)", async () => {
    // A server action is an endpoint: the form is typed, the request is not.
    expect(
      await steerRun("acme", "core-platform", RUN, "go on", "immediately"),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "delivery_mode",
      field: "requestedMode",
    });
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

describe("readRunExport", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const ROOT = `sha256:${"b".repeat(64)}`;
  /** Every field `get_run_export`'s strict output schema requires, for a ready bundle. */
  const ready = {
    exportId: "rexp_1",
    runId: RUN,
    status: "ready",
    createdAt: "2026-09-22T10:00:00.000Z",
    completedAt: "2026-09-22T10:00:07.000Z",
    bundleDigest: DIGEST,
    bundleBytes: 48_213,
    merkleRoot: ROOT,
    frameCount: 412,
    error: null,
    download: {
      url: "https://api.oxagen.sh/v1/run-exports/download?token=t0k",
      expiresAt: "2026-09-22T10:15:07.000Z",
    },
  } as const;

  it("reads the export by its id and answers the contract's record", async () => {
    invoke.mockResolvedValue(ready);
    expect(await readRunExport("acme", "core-platform", "rexp_1")).toEqual({
      ok: true,
      value: ready,
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "get_run_export",
      { exportId: "rexp_1" },
      expect.objectContaining(TENANT),
    );
  });

  it("answers an export from another workspace as not_found with the handler's reason (negative)", async () => {
    invoke.mockRejectedValue({
      code: "not_found",
      reason: "run_export_not_found",
      message: "run export not found",
    });
    expect(await readRunExport("acme", "core-platform", "rexp_9")).toEqual({
      ok: false,
      reason: "not_found",
      code: "run_export_not_found",
    });
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("get_run_export"));
    expect(
      await readRunExport("acme", "core-platform", "rexp_1"),
    ).toMatchObject({ ok: false, reason: "denied" });
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
    expect(await bisectRuns("acme", "core-platform", RUN, "arun_9f2a")).toEqual(
      {
        ok: true,
        value: { divergentSeq: null, keyA: null, keyB: null, aligned: 431 },
      },
    );
  });

  it("refuses an empty second run, and this run compared with itself, before the kernel (negative)", async () => {
    for (const other of ["", "   ", RUN]) {
      expect(await bisectRuns("acme", "core-platform", RUN, other)).toEqual({
        ok: false,
        reason: "invalid",
        code: "run_b",
        field: "runB",
      });
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

  it("maps a page exactly as the port does, so a first page and a later one cannot disagree", async () => {
    const { toRunTranscript } = await import("@/data/live/mappers/run");
    const out: TranscriptOutput = {
      zoom: "steps",
      kinds: [],
      entries: [
        {
          seq: "11",
          endSeq: "14",
          at: "2026-09-15T08:10:00.000Z",
          elapsedMs: 3000,
          kind: "tool_call",
          type: "tool_result",
          label: "create_release ok",
          callId: "tc_1",
          kinds: ["tools"],
          turn: 1,
          request: null,
          response: null,
          decision: null,
          frames: 4,
          cost: {
            micros: "18240",
            currency: "USD",
            basis: "gateway_observed",
          },
          cumulativeCost: {
            micros: "4131265",
            currency: "USD",
            basis: "gateway_observed",
          },
        },
      ],
      cursor: "ZjoxMQ",
      complete: false,
    };
    invoke.mockResolvedValue(out);
    const page = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "steps",
      [],
      "ZjoxMA",
    );
    // The layer matrix keeps `features/*` out of `data/live`, so the action
    // carries its own copy of the port's mapping. This is what stops the two
    // drifting: a test may import both, and production may not.
    expect(page).toEqual({
      ok: true,
      value: toRunTranscript(out),
    });
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
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_cursor",
      field: "after",
    });
  });

  // A page whose mapped shape the app's own `RunTranscript` schema refuses
  // cannot be produced through this file's fake boundary: `kernelRead`'s real
  // `contract.output.safeParse` already validates the mocked `invoke` result
  // against the (`.strict()`, identically-shaped) contract schema before this
  // module ever sees it, so a value that clears that gate always clears the
  // app's looser view schema too. The `captureError` report on that branch is
  // proved directly against `data/live/runs.ts`'s `view()` helper instead
  // (`data/live/runs.test.ts`), which is the same defensive parse this file's
  // own copy of the mapping mirrors (see the doc comment on `toTranscriptPage`).
});

describe("the refusals each write carries back", () => {
  it("refuses a halt reason past the contract's ceiling before the kernel runs (negative)", async () => {
    expect(
      await haltRun(
        "acme",
        "core-platform",
        RUN,
        "pause",
        "r".repeat(COMMAND_REASON_MAX + 1),
      ),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a steer the kernel denied as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("dispatch_command"));
    expect(
      await steerRun(
        "acme",
        "core-platform",
        RUN,
        "Stop and re-read the diff.",
        "next_step",
      ),
    ).toMatchObject({ ok: false, reason: "denied" });
  });

  it("returns a bisect the handler refused as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("run_not_found"));
    expect(
      await bisectRuns("acme", "core-platform", RUN, "tse_other1"),
    ).toEqual({ ok: false, reason: "conflict", code: "run_not_found" });
  });
});

describe("setRunEnrichment", () => {
  it("writes only the enrichment switch through update_workspace_settings", async () => {
    invoke.mockRejectedValue(denied("update_workspace_settings"));
    expect(
      await setRunEnrichment("acme", "core-platform", false),
    ).toMatchObject({ ok: false, reason: "denied" });
    expect(invoke).toHaveBeenCalledWith(
      "update_workspace_settings",
      { runEnrichmentEnabled: false },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a value that is not a boolean, as a client posting to the action could send, before the kernel runs (negative)", async () => {
    // A server action is an endpoint: its argument arrives from the wire, so
    // the type the caller was compiled against is not a guarantee.
    const result: unknown = await Reflect.apply(setRunEnrichment, undefined, [
      "acme",
      "core-platform",
      "yes",
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_enrichment_setting",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("readTranscriptPage mapping and refusals", () => {
  const CHAIN = "0b1c2d3e-4f50-4a61-8b72-9c83d94eaf05";
  const body = (seq: string, sessionUuid?: string) => ({
    seq,
    ...(sessionUuid === undefined ? {} : { sessionUuid }),
    type: "model_request",
    digest: null,
    bytesRef: null,
    redactions: [],
    fidelity: "full" as const,
    text: "hello",
    truncated: false,
    assembly: null,
  });

  it("names a subagent's chain on the entry and on each half recorded there, and prints no cost it was not given", async () => {
    const { toRunTranscript } = await import("@/data/live/mappers/run");
    const out: TranscriptOutput = {
      zoom: "everything",
      kinds: [],
      entries: [
        {
          seq: "20",
          endSeq: "22",
          subagent: { sessionUuid: CHAIN, id: null, type: "reviewer" },
          at: "2026-09-15T08:10:00.000Z",
          elapsedMs: 5000,
          kind: "model_call",
          type: "model_request",
          label: "claude-opus-5",
          callId: null,
          kinds: ["prompt", "responses"],
          turn: 2,
          request: body("20", CHAIN),
          response: body("22"),
          decision: {
            seq: "21",
            sessionUuid: CHAIN,
            decision: "allow",
            type: "policy_decision",
            at: "2026-09-15T08:10:01.000Z",
          },
          frames: 3,
          cost: null,
          cumulativeCost: null,
        },
      ],
      cursor: null,
      complete: true,
    };
    invoke.mockResolvedValue(out);
    const page = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "everything",
      [],
      "ZjoxOQ",
    );
    expect(page).toEqual({ ok: true, value: toRunTranscript(out) });
    if (!page.ok) return;
    const [entry] = page.value.entries;
    expect(entry?.subagent).toEqual({ chainRef: CHAIN, type: "reviewer" });
    expect(entry?.request?.chainRef).toBe(CHAIN);
    expect(entry?.response).not.toHaveProperty("chainRef");
    expect(entry?.decision?.chainRef).toBe(CHAIN);
    expect(entry?.cost).toBeNull();
    expect(entry?.cumulativeCost).toBeNull();
  });

  it("carries a denied page across as denied, naming the permission (negative)", async () => {
    invoke.mockRejectedValue(denied("get_run_transcript"));
    const page = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "steps",
      [],
      "ZjoxMQ",
    );
    expect(page).toMatchObject({
      ok: false,
      reason: "denied",
      code: expect.any(String),
    });
  });

  it("carries a parked page across with the request to wait on (negative)", async () => {
    invoke.mockRejectedValue({
      code: "pending_approval",
      accessRequestId: "acr_0202",
    });
    expect(
      await readTranscriptPage(
        "acme",
        "core-platform",
        RUN,
        "steps",
        [],
        "ZjoxMQ",
      ),
    ).toEqual({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_0202",
    });
  });

  it("carries a store that did not answer across as unavailable, not as a bad cursor (negative)", async () => {
    invoke.mockRejectedValue(new Error("socket hang up"));
    const page = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "steps",
      [],
      "ZjoxMQ",
    );
    expect(page).toMatchObject({ ok: false, reason: "unavailable" });
    expect(page).not.toMatchObject({ code: "invalid_cursor" });
  });
});
