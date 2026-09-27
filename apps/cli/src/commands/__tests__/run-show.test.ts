/**
 * `oxagen run show <run-id>` over `get_run` (#2951): --json emits the exact
 * contract payload, pretty mode prints the run's header, the pause in force,
 * one line per frame, the next page's cursor and the subagent chains, a fact
 * the record does not hold reads as "not recorded", and an API failure goes
 * to stderr. --after and --session page a chain (#3823). The API client is
 * mocked; no network.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api.js")>()),
  apiPostOrThrow: vi.fn(),
}));
vi.mock("../../lib/config.js", () => ({
  getApiUrl: () => "https://api.example.test",
}));

import { runShow, type RunShowResult } from "../run.js";
import { apiPostOrThrow } from "../../lib/api.js";

const post = apiPostOrThrow as Mock;

function memoryWriter() {
  const out: string[] = [];
  const err: string[] = [];
  const writer: CommandWriter = {
    write: (line) => {
      out.push(line);
    },
    writeErr: (line) => {
      err.push(line);
    },
  };
  return { writer, out, err };
}

type Run = RunShowResult["run"];
type Pause = NonNullable<Run["pause"]>;

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "tse_0a1b2c",
  name: "Ship the release notes",
  agentKey: "acme.core.release-bot",
  operatorId: "usr_ada",
  operatorName: "Ada Lovelace",
  operatorAttribution: "host_enroller",
  status: "live",
  outcome: "running",
  turns: 3,
  steps: 9,
  frames: 40,
  cost: { micros: "4130000", currency: "USD", basis: "client_attested" },
  costIsEstimate: true,
  startedAt: "2026-09-25T09:00:00.000Z",
  sealedAt: null,
  replayGrade: "inspect",
  enforcementTier: "harness",
  pause: null,
  ...overrides,
});

const FRAMES: RunShowResult["frames"] = {
  frames: [
    {
      seq: "0",
      observedAt: "2026-09-25T09:00:00.000Z",
      type: "session_start",
      summary: "Session started",
    },
    {
      seq: "1",
      observedAt: "2026-09-25T09:00:01.000Z",
      type: "llm_call",
      summary: "Read the release notes",
    },
  ],
  cursor: "cur_2",
};

const shown = (
  runOverrides: Partial<Run> = {},
  rest: Partial<RunShowResult> = {},
): RunShowResult => ({ run: run(runOverrides), frames: FRAMES, ...rest });

const PAUSED: Pause = {
  state: "paused",
  seq: "38",
  turn: 3,
  step: 7,
  by: { id: "usr_ada", name: "Ada Lovelace" },
  issuedAt: "2026-09-25T09:05:00.000Z",
  appliedAt: "2026-09-25T09:05:02.000Z",
  reason: "Check the diff first",
};

const CHAIN_A = "6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b";
const CHAIN_B = "7a2e3d4c-5b6a-4f90-8b1c-2d3e4f5a6b7c";

type Head = NonNullable<RunShowResult["chains"]>["heads"][number];

const head = (overrides: Partial<Head> = {}): Head => ({
  sessionUuid: CHAIN_A,
  parentSessionUuid: null,
  subagentId: "agent-1",
  subagentType: "Explore",
  spawnCallId: "toolu_1",
  lastSeq: "11",
  frameCount: 12,
  ...overrides,
});

/**
 * The header prints one fact per line: the id, agent, status, outcome,
 * operator, tier, grade, start, seal, turns, steps, frames and cost.
 */
const HEADER_LINES = 13;

beforeEach(() => {
  post.mockReset();
});

describe("oxagen run show", () => {
  it("posts the run id to runs/get and emits the exact payload as JSON", async () => {
    const payload = shown();
    post.mockResolvedValue(payload);
    const { writer, out, err } = memoryWriter();
    await runShow("tse_0a1b2c", { json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs/get", { runId: "tse_0a1b2c" });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual(payload);
    expect(err).toEqual([]);
  });

  it("prints the header facts, one row per frame, and the commands that read more", async () => {
    post.mockResolvedValue(shown());
    const { writer, out, err } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out.slice(0, HEADER_LINES)).toEqual([
      "tse_0a1b2c: Ship the release notes",
      "Agent: acme.core.release-bot",
      "Status: live",
      "Outcome: running",
      "Operator: Ada Lovelace (enrolled the host)",
      "Tier: harness",
      "Replay grade: inspect",
      "Started: 2026-09-25T09:00:00.000Z",
      "Sealed: not sealed",
      "Turns: 3",
      "Steps: 9",
      "Frames: 40",
      "Cost: $4.13 (estimate)",
    ]);
    expect(out[HEADER_LINES]).toBe("");
    expect(out[HEADER_LINES + 1]).toMatch(/^Seq\s+Observed\s+Type\s+Summary$/);
    expect((out[HEADER_LINES + 2] ?? "").split(/\s{2,}/)).toEqual([
      "0",
      "2026-09-25T09:00:00.000Z",
      "session_start",
      "Session started",
    ]);
    expect((out[HEADER_LINES + 3] ?? "").split(/\s{2,}/)).toEqual([
      "1",
      "2026-09-25T09:00:01.000Z",
      "llm_call",
      "Read the release notes",
    ]);
    expect(out).toContain("The run holds 40 frames. These are its first 2.");
    expect(out.at(-1)).toBe(
      "Read its cost by turn with `oxagen run turns tse_0a1b2c` and its chain with `oxagen run chain tse_0a1b2c`.",
    );
    expect(err).toEqual([]);
  });

  it("names the operator alone when the run records who started it", async () => {
    post.mockResolvedValue(
      shown({ operatorAttribution: "initiator", costIsEstimate: false }),
    );
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out).toContain("Operator: Ada Lovelace");
    expect(out).toContain("Cost: $4.13");
    expect(out.join("\n")).not.toContain("(enrolled the host)");
    expect(out.join("\n")).not.toContain("(estimate)");
  });

  it("prints where a paused run stopped, who paused it, when, why, and its pause frame", async () => {
    post.mockResolvedValue(shown({ pause: PAUSED }));
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    const at = out.indexOf("Pause: paused");
    expect(at).toBe(HEADER_LINES);
    expect(out.slice(at, at + 6)).toEqual([
      "Pause: paused",
      "  At: turn 3, step 7",
      "  Issued by: Ada Lovelace at 2026-09-25T09:05:00.000Z",
      "  Applied: 2026-09-25T09:05:02.000Z",
      '  Reason: "Check the diff first"',
      "  Pause frame: seq 38",
    ]);
  });

  it("leaves out what a pause not yet applied does not hold (negative)", async () => {
    post.mockResolvedValue(
      shown({
        pause: {
          ...PAUSED,
          state: "pausing",
          seq: null,
          turn: null,
          step: null,
          by: { id: "usr_ada", name: null },
          appliedAt: null,
          reason: null,
        },
      }),
    );
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    const at = out.indexOf("Pause: pausing");
    expect(at).toBe(HEADER_LINES);
    expect(out.slice(at + 1, at + 4)).toEqual([
      "  It takes effect at the next boundary.",
      "  Issued by: usr_ada at 2026-09-25T09:05:00.000Z",
      "",
    ]);
    const text = out.join("\n");
    for (const absent of ["At:", "Applied:", "Reason:", "Pause frame:"]) {
      expect(text).not.toContain(absent);
    }
  });

  it("prints the resume in flight and a pause with no issuer as not recorded", async () => {
    post.mockResolvedValue(
      shown({ pause: { ...PAUSED, state: "resuming", by: null } }),
    );
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    const at = out.indexOf("Pause: resuming");
    expect(at).toBe(HEADER_LINES);
    expect(out[at + 1]).toBe("  A resume is queued behind it.");
    expect(out).toContain(
      "  Issued by: not recorded at 2026-09-25T09:05:00.000Z",
    );
  });

  it("prints no pause line for a run with no pause in force (negative)", async () => {
    post.mockResolvedValue(shown({ pause: undefined }));
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out.join("\n")).not.toContain("Pause:");
  });

  it("says what was not recorded rather than printing a zero (negative)", async () => {
    post.mockResolvedValue({
      run: run({
        id: "arun_5f0c",
        name: null,
        agentKey: null,
        operatorId: null,
        operatorName: null,
        operatorAttribution: null,
        status: "sealed",
        outcome: "completed",
        turns: null,
        steps: 0,
        frames: 0,
        cost: null,
        costIsEstimate: true,
        sealedAt: "2026-09-25T09:10:00.000Z",
        replayGrade: null,
      }),
      frames: { frames: [], cursor: null },
    } satisfies RunShowResult);
    const { writer, out } = memoryWriter();
    await runShow("arun_5f0c", {}, writer);
    expect(out.slice(0, HEADER_LINES)).toEqual([
      "arun_5f0c",
      "Agent: not recorded",
      "Status: sealed",
      "Outcome: completed",
      "Operator: not recorded",
      "Tier: harness",
      "Replay grade: not recorded",
      "Started: 2026-09-25T09:00:00.000Z",
      "Sealed: 2026-09-25T09:10:00.000Z",
      "Turns: not recorded",
      "Steps: 0",
      "Frames: 0",
      "Cost: not recorded",
    ]);
    expect(out).toContain("The run has recorded no frame yet.");
    const text = out.join("\n");
    expect(text).not.toMatch(/\$0(\s|$|\.)/);
    expect(text).not.toContain("The run holds");
  });

  it("prints no cut line when the page holds every frame the run recorded (negative)", async () => {
    post.mockResolvedValue(shown({ frames: 2 }));
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out.join("\n")).not.toContain("The run holds");
  });

  it("says the frames could not be read and prints the header anyway", async () => {
    post.mockResolvedValue(
      shown(
        {},
        {
          frames: { frames: [], cursor: null },
          framesError: {
            code: "frames_unavailable",
            message: "The frame store did not answer.",
          },
        },
      ),
    );
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out[0]).toBe("tse_0a1b2c: Ship the release notes");
    expect(out).toContain(
      "The frames could not be read: The frame store did not answer.",
    );
    const text = out.join("\n");
    expect(text).not.toContain("The run has recorded no frame yet.");
    expect(text).not.toMatch(/^Seq\s/m);
  });

  it("never emits an em dash or en dash separator (clear-prose, negative)", async () => {
    post.mockResolvedValue(shown({ pause: PAUSED }));
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    const text = out.join("\n");
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it("sends --after as framesAfter and --session as sessionUuid", async () => {
    post.mockResolvedValue(shown());
    const { writer } = memoryWriter();
    await runShow("tse_0a1b2c", { after: "cur_2", session: CHAIN_A }, writer);
    expect(post).toHaveBeenCalledWith("runs/get", {
      runId: "tse_0a1b2c",
      framesAfter: "cur_2",
      sessionUuid: CHAIN_A,
    });
  });

  it("names the next page's cursor, with the chain it pages", async () => {
    post.mockResolvedValue(shown({ status: "sealed" }));
    const first = memoryWriter();
    await runShow("tse_0a1b2c", {}, first.writer);
    expect(first.out).toContain("Next page: pass --after cur_2.");
    expect(first.out.join("\n")).not.toContain("A live run keeps a cursor");

    const chain = memoryWriter();
    await runShow("tse_0a1b2c", { session: CHAIN_A }, chain.writer);
    expect(chain.out).toContain(`Chain: ${CHAIN_A}`);
    expect(chain.out).toContain(
      `Next page: pass --after cur_2 --session ${CHAIN_A}.`,
    );
  });

  it("says a live run's cursor also reads what the run records next", async () => {
    post.mockResolvedValue(shown());
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out).toContain(
      "A live run keeps a cursor after its last frame. Its next page holds what the run records next.",
    );
  });

  it("prints no next page when the read answers no cursor (negative)", async () => {
    post.mockResolvedValue(
      shown(
        { status: "sealed", frames: 2 },
        { frames: { ...FRAMES, cursor: null } },
      ),
    );
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out.join("\n")).not.toContain("Next page");
  });

  it("does not set a later page, or a subagent chain, against the run's frame count (negative)", async () => {
    post.mockResolvedValue(shown());
    const later = memoryWriter();
    await runShow("tse_0a1b2c", { after: "cur_2" }, later.writer);
    expect(later.out.join("\n")).not.toContain("The run holds");

    const chain = memoryWriter();
    await runShow("tse_0a1b2c", { session: CHAIN_A }, chain.writer);
    expect(chain.out.join("\n")).not.toContain("The run holds");
  });

  it("says nothing lies past the cursor, rather than that the run recorded nothing (negative)", async () => {
    post.mockResolvedValue(shown({}, { frames: { frames: [], cursor: null } }));
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", { after: "cur_9" }, writer);
    expect(out).toContain("No frame lies past that cursor yet.");
    expect(out.join("\n")).not.toContain("The run has recorded no frame yet.");
  });

  it("lists each subagent chain's head and how to read its frames", async () => {
    post.mockResolvedValue(
      shown(
        {},
        {
          chains: {
            cursor: "ch_1",
            complete: false,
            heads: [
              head({ sessionUuid: CHAIN_A, subagentType: "Explore" }),
              head({
                sessionUuid: CHAIN_B,
                subagentType: null,
                lastSeq: null,
                frameCount: 0,
              }),
            ],
          },
        },
      ),
    );
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    const at = out.indexOf("Subagent chains: 2+");
    expect(at).toBeGreaterThan(HEADER_LINES);
    expect(out[at + 1]).toMatch(/^Session\s+Type\s+Frames\s+Last seq$/);
    expect((out[at + 2] ?? "").split(/\s{2,}/)).toEqual([
      CHAIN_A,
      "Explore",
      "12",
      "11",
    ]);
    expect((out[at + 3] ?? "").split(/\s{2,}/)).toEqual([
      CHAIN_B,
      "not recorded",
      "0",
      "none",
    ]);
    expect(out[at + 4]).toBe(
      "The run has more subagent chains than one read lists.",
    );
    expect(out[at + 5]).toBe(
      "Read a chain's frames with `oxagen run show tse_0a1b2c --session <session>`.",
    );
  });

  it("prints no chains section for a run with no subagent chain (negative)", async () => {
    post.mockResolvedValue(
      shown({}, { chains: { cursor: "ch_0", complete: true, heads: [] } }),
    );
    const { writer, out } = memoryWriter();
    await runShow("tse_0a1b2c", {}, writer);
    expect(out.join("\n")).not.toContain("Subagent chains");
  });

  it("routes an API failure to stderr and writes nothing to stdout (negative)", async () => {
    post.mockRejectedValue(new Error("404 not_found: run_not_found"));
    const { writer, out, err } = memoryWriter();
    await runShow("tse_nope", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/run_not_found/);
  });
});
