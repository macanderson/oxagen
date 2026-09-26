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
import { PAGE_FAILURES } from "@/data/read";
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
  readDeliveryReport,
  readRunExport,
  readTranscriptPage,
  sealRun,
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

describe("sealRun", () => {
  const answer = {
    runId: RUN,
    sealedAt: "2026-09-24T12:00:00.000Z",
    sessionsSealed: 2,
    kill: { status: "queued" as const, commandId: "tcm_kill1" },
  };

  it("seals this run with the trimmed reason and answers what seal_run did", async () => {
    invoke.mockResolvedValue(answer);
    expect(
      await sealRun("acme", "core-platform", RUN, "  finished at noon  "),
    ).toEqual({ ok: true, value: answer });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "seal_run",
      { runId: RUN, reason: "finished at noon" },
      expect.objectContaining(TENANT),
    );
  });

  it("sends no reason when the field was left blank, rather than an empty one", async () => {
    invoke.mockResolvedValue(answer);
    await sealRun("acme", "core-platform", RUN, "   ");
    expect(invoke.mock.calls[0]?.[1]).toEqual({ runId: RUN });
  });

  it("refuses a reason past the contract's ceiling before the kernel runs (negative)", async () => {
    expect(
      await sealRun(
        "acme",
        "core-platform",
        RUN,
        "x".repeat(COMMAND_REASON_MAX + 1),
      ),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("seal_run"));
    expect(await sealRun("acme", "core-platform", RUN, "done")).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
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

  it("refuses a reason past the contract's ceiling on the reason field, before the kernel runs (negative)", async () => {
    expect(
      await haltRun(
        "acme",
        "core-platform",
        RUN,
        "pause",
        ` ${"x".repeat(COMMAND_REASON_MAX + 1)} `,
      ),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("measures the reason after trimming, so padding does not push one at the ceiling over it", async () => {
    invoke.mockResolvedValue({ commandIds: ["tcm_5"] });
    const atCeiling = "x".repeat(COMMAND_REASON_MAX);
    expect(
      await haltRun("acme", "core-platform", RUN, "cancel", `  ${atCeiling}  `),
    ).toEqual({ ok: true, value: { commandIds: ["tcm_5"] } });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ reason: atCeiling });
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

  it("returns a denial as denied, and never claims the steer was queued (negative)", async () => {
    invoke.mockRejectedValue(denied("dispatch_command"));
    const result = await steerRun(
      "acme",
      "core-platform",
      RUN,
      "use the 3.2 branch",
      "next_step",
    );
    expect(result).toMatchObject({ ok: false, reason: "denied" });
    expect(result).not.toHaveProperty("value");
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

  it("returns the handler's refusal to compare as a conflict naming it (negative)", async () => {
    invoke.mockRejectedValue(refused("run_not_found"));
    expect(
      await bisectRuns("acme", "core-platform", RUN, "arun_9f2a"),
    ).toMatchObject({ ok: false, reason: "conflict", code: "run_not_found" });
  });
});

describe("setRunEnrichment", () => {
  it("writes the workspace's automatic names setting and answers what the contract wrote", async () => {
    const written = {
      name: "Core platform",
      slug: "core-platform",
      description: null,
      avatarUrl: null,
      consequenceRoles: {},
      steering: { autoSync: false, blockStaleRuns: false },
      runEnrichmentEnabled: false,
    };
    invoke.mockResolvedValue(written);
    expect(await setRunEnrichment("acme", "core-platform", false)).toEqual({
      ok: true,
      value: written,
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "update_workspace_settings",
      { runEnrichmentEnabled: false },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a setting that is not a yes or a no before the kernel runs (negative)", async () => {
    // A server action is an endpoint: the switch is typed, the request is not.
    expect(
      await Reflect.apply(setRunEnrichment, undefined, [
        "acme",
        "core-platform",
        "false",
      ]),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_enrichment_setting",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("update_workspace_settings"));
    expect(await setRunEnrichment("acme", "core-platform", true)).toMatchObject(
      { ok: false, reason: "denied" },
    );
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
      // Where a live reader's stream opens (A-06); it maps through as is.
      frameCursor: "Zjo0",
    });
    const read = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "steps",
      { kinds: ["tools"], after: "ZjoxMQ" },
    );
    expect(read).toEqual({
      ok: true,
      value: {
        zoom: "steps",
        kinds: ["tools"],
        entries: [],
        cursor: null,
        complete: true,
        frameCursor: "Zjo0",
        counts: null,
        figures: null,
        search: null,
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
          target: "gh release create v1.2.0",
          effort: "high",
          subagent: {
            sessionUuid: "7f0c2d1e-5b8a-4c3d-9e2f-1a2b3c4d5e6f",
            id: "agent_1",
            type: "general-purpose",
            spawnCallId: "tu_spawn",
          },
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
      { after: "ZjoxMA" },
    );
    expect(page).toEqual({ ok: true, value: toRunTranscript(out) });
  });

  it("carries a later page's assembled reply as blocks and text, as the first page does (#3375)", async () => {
    // A later page was mapped by a second copy of the port's mapper, which
    // kept no blocks and no text from the assembly: the reply the first page
    // drew was blank once it scrolled onto a later page. Both pages now read
    // the port, and this pins that on a half that carries an assembly.
    const { toRunTranscript } = await import("@/data/live/mappers/run");
    const block = { chars: 0, tokens: 0, partial: false, cost: null };
    const out: TranscriptOutput = {
      zoom: "everything",
      kinds: [],
      entries: [
        {
          seq: "22",
          endSeq: "22",
          at: "2026-09-15T08:12:00.000Z",
          elapsedMs: 1800,
          kind: "model_call",
          type: "model.response",
          label: "anthropic/claude-sonnet-4-5",
          callId: "msg_1",
          kinds: ["responses"],
          turn: 2,
          request: null,
          response: {
            seq: "22",
            type: "model.response",
            digest: `sha256:${"b".repeat(64)}`,
            bytesRef: "evb:v1:k:def",
            redactions: [],
            fidelity: "full",
            text: null,
            truncated: false,
            assembly: {
              blocks: [
                {
                  ...block,
                  id: "b0",
                  kind: "text",
                  text: "Release notes are drafted.",
                  truncated: false,
                },
                {
                  ...block,
                  id: "b1",
                  kind: "tool_use",
                  name: "create_release",
                  input: { tag: "v1.2.0" },
                  inputRaw: false,
                  inputFolded: false,
                  callKey: "tu_1",
                  verdict: null,
                },
              ],
              precis: "text, 1 tool call",
              stopReason: "tool_use",
              ttftMs: 400,
              durationMs: 1800,
              tokensPerSecond: null,
              usage: {
                inputTokens: 1200,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 40,
              },
              partial: false,
              wire: { events: 12, bytes: 2048 },
            },
          },
          decision: null,
          frames: 1,
          cost: null,
          cumulativeCost: null,
        },
      ],
      cursor: "ZjoyMg",
      complete: false,
    };
    invoke.mockResolvedValue(out);
    const page = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "everything",
      { after: "ZjoxMQ" },
    );
    expect(page).toEqual({ ok: true, value: toRunTranscript(out) });
    if (!page.ok) throw new Error("the page was read");
    const response = page.value.entries[0]?.response;
    expect(response?.blocks).toEqual([
      { kind: "text", text: "Release notes are drafted." },
      {
        kind: "tool_use",
        name: "create_release",
        input: { tag: "v1.2.0" },
        callKey: "tu_1",
        stepKey: null,
        result: null,
        family: null,
        tool: null,
      },
    ]);
    expect(response?.text).toBe(
      'Release notes are drafted.\n\ncreate_release\n{\n  "tag": "v1.2.0"\n}',
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
      await readTranscriptPage("acme", "core-platform", RUN, "steps", {
        after: "not-a-cursor",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_cursor",
      field: "after",
    });
  });

  it("asks for whole bodies and a search, and reads the first page of matches with no cursor", async () => {
    invoke.mockResolvedValue({
      zoom: "steps",
      kinds: [],
      entries: [],
      cursor: null,
      complete: true,
      search: { query: "retry", matched: 0, unsearched: 2 },
    });
    const read = await readTranscriptPage(
      "acme",
      "core-platform",
      RUN,
      "steps",
      {
        text: "full",
        query: "retry",
      },
    );
    expect(invoke).toHaveBeenCalledWith(
      "get_run_transcript",
      {
        runId: RUN,
        zoom: "steps",
        kinds: [],
        limit: 200,
        text: "full",
        query: "retry",
      },
      expect.objectContaining(TENANT),
    );
    expect(read.ok && read.value.search).toEqual({
      query: "retry",
      matched: 0,
      unsearched: 2,
    });
  });

  it("answers a search the contract refuses as invalid on the query, not on a cursor it was not sent (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        "get_run_transcript",
        "invalid_input",
        "query too long",
      ),
    );
    expect(
      await readTranscriptPage("acme", "core-platform", RUN, "steps", {
        query: "x",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_query",
      field: "query",
    });
  });

  it("answers a denied read as denied, naming the permission the Run page needs (negative)", async () => {
    invoke.mockRejectedValue(denied("get_run_transcript"));
    expect(
      await readTranscriptPage("acme", "core-platform", RUN, "steps", {
        after: "ZjoxMQ",
      }),
    ).toEqual({
      ok: false,
      reason: "denied",
      code: PAGE_FAILURES.run.permission,
    });
  });

  it("answers a read parked for approval with the request to wait on (negative)", async () => {
    invoke.mockRejectedValue({
      code: "pending_approval",
      accessRequestId: "areq_01k4qj9e",
    });
    expect(
      await readTranscriptPage("acme", "core-platform", RUN, "steps", {
        after: "ZjoxMQ",
      }),
    ).toEqual({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "areq_01k4qj9e",
    });
  });

  it("answers a run the workspace does not hold as not_found with the handler's reason, not as a bad cursor (negative)", async () => {
    invoke.mockRejectedValue({
      code: "not_found",
      reason: "run_not_found",
      message: "run not found",
    });
    expect(
      await readTranscriptPage("acme", "core-platform", RUN, "steps", {
        after: "ZjoxMQ",
      }),
    ).toEqual({ ok: false, reason: "not_found", code: "run_not_found" });
  });

  it("answers a store that failed as unavailable with the Run page's error code, not as invalid (negative)", async () => {
    invoke.mockRejectedValue(new Error("clickhouse unreachable"));
    expect(
      await readTranscriptPage("acme", "core-platform", RUN, "steps", {
        after: "ZjoxMQ",
      }),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      code: PAGE_FAILURES.run.error.code,
    });
  });

  it("names the subagent chain on the entry and on each half recorded there, and on neither half recorded on the run's own", async () => {
    const { toRunTranscript } = await import("@/data/live/mappers/run");
    const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
    type Half = NonNullable<TranscriptOutput["entries"][number]["request"]>;
    const half: Omit<Half, "seq"> = {
      type: "tool_call",
      digest: `sha256:${"a".repeat(64)}`,
      bytesRef: "evb:v1:k:abc",
      redactions: [],
      fidelity: "full",
      text: '{"open":34}',
      truncated: false,
      assembly: null,
    };
    const out: TranscriptOutput = {
      zoom: "everything",
      kinds: [],
      entries: [
        {
          seq: "3",
          endSeq: "4",
          subagent: { sessionUuid: CHAIN, id: "agent_1", type: "Explore" },
          at: "2026-09-15T08:10:00.000Z",
          elapsedMs: 3000,
          kind: "tool_call",
          type: "tool_requested",
          label: "list_pull_requests",
          callId: "tc_2",
          usage: {
            inputUncached: 10,
            cacheRead: 90,
            cacheWrite: null,
            output: 5,
            reasoning: null,
          },
          kinds: ["tools", "policy"],
          turn: 2,
          request: { ...half, seq: "3", sessionUuid: CHAIN },
          response: { ...half, seq: "4" },
          decision: {
            seq: "4",
            sessionUuid: CHAIN,
            decision: "allow",
            type: "policy_decision",
            harness: false,
            at: "2026-09-15T08:10:01.000Z",
          },
          frames: 2,
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
      { after: "ZjoxMA" },
    );
    expect(page).toEqual({ ok: true, value: toRunTranscript(out) });
    if (!page.ok) throw new Error("the page was read");
    const [entry] = page.value.entries;
    // #4026 carries the spawning call's id as `spawnKey`; this wire entry
    // recorded none, so it reads null rather than being left off.
    expect(entry?.subagent).toEqual({
      chainRef: CHAIN,
      type: "Explore",
      spawnKey: null,
    });
    expect(entry?.request?.chainRef).toBe(CHAIN);
    expect(entry?.response).not.toHaveProperty("chainRef");
    expect(entry?.decision?.chainRef).toBe(CHAIN);
    expect(entry?.cost).toBeNull();
    expect(entry?.usage).toEqual({
      inputUncached: 10,
      cacheRead: 90,
      cacheWrite: null,
      output: 5,
      reasoning: null,
    });
  });

  // A page whose mapped shape the app's own `RunTranscript` schema refuses
  // cannot be produced through this file's fake boundary: `kernelRead`'s real
  // `contract.output.safeParse` already validates the mocked `invoke` result
  // against the (`.strict()`, identically-shaped) contract schema before the
  // port maps it, so a value that clears that gate always clears the app's
  // looser view schema too. The `captureError` report on that branch belongs
  // to the port's `view()` helper and is proved in `data/live/runs.test.ts`.
});

// #2953: the delivery report reads list_commands through the runs port, one
// run's commands or a broadcast's by id, and never reads for a query that
// names neither.
describe("readDeliveryReport", () => {
  const command = {
    id: "tcm_1",
    runId: RUN,
    agentKey: null,
    command: "steer",
    status: "applied",
    requestedMode: "interrupt",
    deliveryMode: "next_step",
    degradedReason: "harness_tier",
    reason: null,
    issuedAt: "2026-09-15T08:10:00.000Z",
    expiresAt: null,
    sentAt: "2026-09-15T08:10:02.000Z",
    acknowledgedAt: "2026-09-15T08:10:05.000Z",
    appliedAt: "2026-09-15T08:10:05.000Z",
    appliedAtSeq: 41,
    detail: null,
    issuedBy: { id: "usr_0a", name: "Ada Park" },
    text: "Run the migration tests before you push.",
  };

  it("reads one run's commands and answers them with both modes", async () => {
    invoke.mockResolvedValue({ commands: [command] });
    expect(
      await readDeliveryReport("acme", "core-platform", { runId: RUN }),
    ).toEqual({ ok: true, value: { commands: [command] } });
    expect(invoke).toHaveBeenCalledWith(
      "list_commands",
      { runId: RUN, limit: 100 },
      expect.objectContaining(TENANT),
    );
  });

  it("reads a broadcast's commands by their ids", async () => {
    invoke.mockResolvedValue({ commands: [command] });
    await readDeliveryReport("acme", "core-platform", {
      commandIds: ["tcm_1", "tcm_2"],
    });
    expect(invoke).toHaveBeenCalledWith(
      "list_commands",
      { commandIds: ["tcm_1", "tcm_2"], limit: 2 },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses more command ids than one report reads, before any read (negative)", async () => {
    const commandIds = Array.from({ length: 1_001 }, (_, i) => `tcm_${i}`);
    expect(
      await readDeliveryReport("acme", "core-platform", { commandIds }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "report_query",
      field: "q",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a query that names neither a run nor a command, before any read (negative)", async () => {
    for (const q of [{}, { commandIds: [] }, { runId: RUN, commandIds: ["tcm_1"] }]) {
      expect(
        await readDeliveryReport(
          "acme",
          "core-platform",
          q as Parameters<typeof readDeliveryReport>[2],
        ),
      ).toEqual({
        ok: false,
        reason: "invalid",
        code: "report_query",
        field: "q",
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers a denied read as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("list_commands"));
    expect(
      await readDeliveryReport("acme", "core-platform", { runId: RUN }),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});
