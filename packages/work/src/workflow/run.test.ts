// run.test.ts: the workflow state machine, one event at a time, over the
// spec's fix-test-verify-review file and a small file that forks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { AutonomyDecision } from "../autonomy/autonomy-allows";
import type { QuotedNote } from "./launch";
import { parseWorkflow, type ResolvedWorkflow } from "./parse";
import {
  type AcceptPrincipal,
  advanceWorkflow,
  initialWorkflowState,
  MAX_NOTE_LENGTH,
  type RefusalCode,
  screenNote,
  type StageRecord,
  WORK_STAGE_COMPLETED_EVENT,
  type WorkflowAction,
  type WorkflowEvent,
  type WorkflowState,
} from "./run";
import type { VerifyAdmission } from "./verify";

const FIXTURES = fileURLToPath(new URL("../../fixtures/workflows/", import.meta.url));

function resolve(doc: unknown, slug: string): ResolvedWorkflow {
  const result = parseWorkflow(doc, slug);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.workflow;
}

/** The spec's example: Fix, Test (returns to Fix twice), Verify, Review (returns to Fix once). */
const spec = resolve(
  parseToml(readFileSync(join(FIXTURES, "fix-test-verify-review.toml"), "utf8")),
  "fix-test-verify-review",
);

/** Fix, then Test and Docs side by side, then Review after Test. Test and Docs may return to Fix. */
const fork = resolve(
  {
    schema: "oxagen-workflow/v0.3",
    name: "Fix, then test and document",
    owner: "priya",
    stage: [
      { role: "Fix", agent: "aintel.core.bug-fixer" },
      {
        role: "Test",
        kind: "test",
        agent: "aintel.core.test-writer",
        needs: ["Fix"],
        on_fail: "return",
        return_to: "Fix",
        max_returns: 2,
      },
      {
        role: "Docs",
        kind: "review",
        agent: "aintel.core.doc-writer",
        needs: ["Fix"],
        owns: ["docs"],
        on_fail: "return",
        return_to: "Fix",
        max_returns: 1,
      },
      { role: "Review", kind: "review", agent: "aintel.core.architect", needs: ["Test"] },
    ],
  },
  "fix-test-and-document",
);

/** Fix, Test, and Review in a line, where Review sends work back to Test, not Fix. */
const chain = resolve(
  {
    schema: "oxagen-workflow/v0.3",
    name: "Fix, test, review",
    owner: "priya",
    stage: [
      { role: "Fix", agent: "aintel.core.bug-fixer" },
      { role: "Test", kind: "test", agent: "aintel.core.test-writer" },
      {
        role: "Review",
        kind: "review",
        agent: "aintel.core.architect",
        on_fail: "return",
        return_to: "Test",
        max_returns: 1,
      },
    ],
  },
  "fix-test-review",
);

const start = (workflow: ResolvedWorkflow = spec): WorkflowState =>
  initialWorkflowState({ workOrderId: "wo-1", orgId: "org-1", workspaceId: "ws-1", operator: "priya", workflow });

interface Step {
  state: WorkflowState;
  actions: WorkflowAction[];
}

function step(state: WorkflowState, event: WorkflowEvent): Step {
  const result = advanceWorkflow(state, event);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { state: result.state, actions: result.actions };
}

function refused(state: WorkflowState, event: WorkflowEvent): { code: RefusalCode; message: string } {
  const result = advanceWorkflow(state, event);
  if (result.ok) throw new Error(`Expected advanceWorkflow to refuse ${event.type}.`);
  return { code: result.code, message: result.message };
}

const record = (state: WorkflowState, role: string): StageRecord =>
  state.stages.find((stage) => stage.role === role) as StageRecord;

const sessionOf = (role: string, run: number): string => `s-${role.toLowerCase()}-${run}`;

/** The session of a stage's newest run. */
const latestSession = (state: WorkflowState, role: string): string =>
  record(state, role).runs.at(-1)?.sessionId as string;

/** Start a stage's newest run on session s-<role>-<run>. */
function started(state: WorkflowState, role: string): WorkflowState {
  const run = record(state, role).runs.length;
  return step(state, { type: "stage_started", role, run, sessionId: sessionOf(role, run) }).state;
}

function handOff(state: WorkflowState, role: string, note = `${role} handed off.`, admission?: VerifyAdmission): Step {
  return step(state, { type: "hand_off", role, sessionId: latestSession(state, role), note, admission });
}

/** The launches among the actions, as [role, run]. */
const launches = (actions: WorkflowAction[]): [string, number][] =>
  actions.flatMap((action): [string, number][] => (action.type === "launch" ? [[action.role, action.run]] : []));

const emit = (role: string, sessionId: string): WorkflowAction => ({
  type: "emit",
  name: WORK_STAGE_COMPLETED_EVENT,
  data: { org_id: "org-1", workspace_id: "ws-1", work_order_id: "wo-1", role, session_id: sessionId },
});

const ADMITTED: VerifyAdmission = { admitted: true, verifyModels: ["verify-route"], buildModels: ["build-a"] };

/** Fix handed off, and Test run 1 is running on s-test-1. */
const atTest = (): WorkflowState =>
  started(handOff(started(step(start(), { type: "send" }).state, "Fix"), "Fix").state, "Test");

/** Test handed off, and Verify run 1 is running on s-verify-1. */
const atVerify = (): WorkflowState => started(handOff(atTest(), "Test").state, "Verify");

/** Verify handed off with the gateway's admission, and Review run 1 is running on s-review-1. */
const atReview = (): WorkflowState => started(handOff(atVerify(), "Verify", "Verified.", ADMITTED).state, "Review");

describe("screenNote", () => {
  it("drops control characters other than tab and newline", () => {
    expect(screenNote("a\u0000b\tc\nd\re\u001b[31mf\u007fg\u0085h\u009fi j")).toBe("ab\tc\nde[31mfghi j");
  });

  it("caps a note at MAX_NOTE_LENGTH characters, counting only what it keeps", () => {
    expect(MAX_NOTE_LENGTH).toBe(8000);
    expect(screenNote("x".repeat(9000))).toBe("x".repeat(8000));
    expect(screenNote(`${"\u0000".repeat(10)}${"y".repeat(8005)}`)).toBe("y".repeat(8000));
  });
});

describe("initialWorkflowState", () => {
  it("starts queued, with every stage waiting and nothing held", () => {
    const state = start();
    expect(state).toEqual({
      workOrderId: "wo-1",
      orgId: "org-1",
      workspaceId: "ws-1",
      operator: "priya",
      workflow: spec,
      status: "queued",
      stages: ["Fix", "Test", "Verify", "Review"].map((role) => ({
        role,
        state: "waiting",
        runs: [],
        returns: 0,
        rerun: false,
        pendingReturns: [],
      })),
      holds: [],
      acceptedBy: null,
    });
  });
});

describe("advanceWorkflow: send and stage_started", () => {
  it("launches the first stage and leaves the state it was given untouched", () => {
    const queued = start();
    const before = structuredClone(queued);
    const { state, actions } = step(queued, { type: "send" });
    expect(queued).toEqual(before);
    expect(state.status).toBe("sent");
    expect(actions).toEqual([{ type: "launch", role: "Fix", run: 1, launchId: "wo-1:stage-1:run-1", notes: [] }]);
    expect(record(state, "Fix")).toEqual({
      role: "Fix",
      state: "launching",
      runs: [{ run: 1, launchId: "wo-1:stage-1:run-1", sessionId: null, outcome: null, note: null }],
      returns: 0,
      rerun: false,
      pendingReturns: [],
    });
    expect(refused(state, { type: "send" })).toEqual({
      code: "already_sent",
      message: "Work order wo-1 was already sent.",
    });
  });

  it("records the session a launch started, and refuses a start it does not expect", () => {
    const sent = step(start(), { type: "send" }).state;
    expect(refused(sent, { type: "stage_started", role: "Deploy", run: 1, sessionId: "s-1" })).toEqual({
      code: "unknown_stage",
      message: "Workflow fix-test-verify-review has no stage Deploy.",
    });
    expect(refused(sent, { type: "stage_started", role: "Test", run: 1, sessionId: "s-1" })).toEqual({
      code: "not_launching",
      message: "Stage Test has no run waiting to start.",
    });
    expect(refused(sent, { type: "stage_started", role: "Fix", run: 2, sessionId: "s-1" })).toEqual({
      code: "stale_run",
      message: "Stage Fix is on run 1, not run 2.",
    });

    const { state, actions } = step(sent, { type: "stage_started", role: "Fix", run: 1, sessionId: "s-fix-1" });
    expect(actions).toEqual([]);
    expect(state.status).toBe("in_progress");
    expect(record(state, "Fix").state).toBe("running");
    expect(record(state, "Fix").runs[0]?.sessionId).toBe("s-fix-1");
    expect(refused(state, { type: "stage_started", role: "Fix", run: 1, sessionId: "s-fix-1" }).code).toBe(
      "not_launching",
    );

    // A later stage's start leaves the status in progress.
    expect(atTest().status).toBe("in_progress");
  });
});

describe("advanceWorkflow: hand_off", () => {
  it("closes the run, sends work/stage.completed, and launches the next stage with the note quoted", () => {
    const running = started(step(start(), { type: "send" }).state, "Fix");
    const { state, actions } = step(running, {
      type: "hand_off",
      role: "Fix",
      sessionId: "s-fix-1",
      note: "Guarded the null total.\u0007",
    });
    const note: QuotedNote = {
      role: "Fix",
      run: 1,
      sessionId: "s-fix-1",
      kind: "handoff",
      text: "Guarded the null total.",
      items: [],
    };
    expect(actions).toEqual([
      emit("Fix", "s-fix-1"),
      { type: "launch", role: "Test", run: 1, launchId: "wo-1:stage-2:run-1", notes: [note] },
    ]);
    expect(record(state, "Fix")).toMatchObject({ state: "handed_off", runs: [{ outcome: "handed_off", note }] });
    expect(record(state, "Test").state).toBe("launching");
  });

  it("refuses a session that is not a run of the stage, and a stage the file does not have", () => {
    const running = started(step(start(), { type: "send" }).state, "Fix");
    expect(refused(running, { type: "hand_off", role: "Fix", sessionId: "s-other", note: "" })).toEqual({
      code: "unknown_session",
      message: "Session s-other is not a run of stage Fix.",
    });
    expect(refused(running, { type: "return", role: "Deploy", sessionId: "s-fix-1", items: [1], note: "" })).toEqual({
      code: "unknown_stage",
      message: "Workflow fix-test-verify-review has no stage Deploy.",
    });
  });

  it("refuses a second handoff or return from a closed run, and ignores its late session end", () => {
    const handed = handOff(started(step(start(), { type: "send" }).state, "Fix"), "Fix").state;
    const closed = { code: "not_running", message: "The run for session s-fix-1 already closed." };
    expect(refused(handed, { type: "hand_off", role: "Fix", sessionId: "s-fix-1", note: "" })).toEqual(closed);
    expect(refused(handed, { type: "return", role: "Fix", sessionId: "s-fix-1", items: [1], note: "" })).toEqual(
      closed,
    );
    const late = step(handed, { type: "session_ended", role: "Fix", sessionId: "s-fix-1" });
    expect(late.actions).toEqual([]);
    expect(late.state).toEqual(handed);
  });
});

describe("advanceWorkflow: return", () => {
  it("refuses a return that names no item, or an item that is not a whole number from 1", () => {
    const test = atTest();
    const bad = {
      code: "bad_items",
      message: "A return names one or more done record item numbers, each a whole number from 1.",
    };
    for (const items of [[], [0], [2.5], [1, -1]]) {
      expect(refused(test, { type: "return", role: "Test", sessionId: "s-test-1", items, note: "" })).toEqual(bad);
    }
  });

  it("sends the work back to the role the file names, with the return note, and counts the return", () => {
    const { state, actions } = step(atTest(), {
      type: "return",
      role: "Test",
      sessionId: "s-test-1",
      items: [3, 1, 3],
      note: "Item 1 has no failing test.",
    });
    const note: QuotedNote = {
      role: "Test",
      run: 1,
      sessionId: "s-test-1",
      kind: "return",
      text: "Item 1 has no failing test.",
      items: [1, 3],
    };
    expect(actions).toEqual([
      emit("Test", "s-test-1"),
      { type: "launch", role: "Fix", run: 2, launchId: "wo-1:stage-1:run-2", notes: [note] },
    ]);
    expect(record(state, "Test")).toMatchObject({ state: "to_run_again", returns: 1, rerun: false });
    expect(record(state, "Test").runs[0]).toMatchObject({ outcome: "returned", note });
    expect(record(state, "Fix")).toMatchObject({ state: "launching", pendingReturns: [] });
    expect(record(state, "Verify").state).toBe("waiting");
  });

  it("runs Fix and Test again after a return, and Test's next handoff moves the work on to Verify", () => {
    let state = step(atTest(), { type: "return", role: "Test", sessionId: "s-test-1", items: [1], note: "" }).state;
    state = started(state, "Fix");
    let next = handOff(state, "Fix", "Added the failing test first.");
    expect(next.actions).toEqual([
      emit("Fix", "s-fix-2"),
      {
        type: "launch",
        role: "Test",
        run: 2,
        launchId: "wo-1:stage-2:run-2",
        notes: [
          { role: "Fix", run: 2, sessionId: "s-fix-2", kind: "handoff", text: "Added the failing test first.", items: [] },
        ],
      },
    ]);
    state = started(next.state, "Test");
    next = handOff(state, "Test");
    expect(launches(next.actions)).toEqual([["Verify", 1]]);
    expect(record(next.state, "Test").runs.map((run) => run.outcome)).toEqual(["returned", "handed_off"]);
  });

  it("sends a review return back through every stage after Fix", () => {
    const { state, actions } = step(atReview(), {
      type: "return",
      role: "Review",
      sessionId: "s-review-1",
      items: [2],
      note: "The fix hides the error.",
    });
    expect(launches(actions)).toEqual([["Fix", 2]]);
    expect(state.stages.map((stage) => [stage.role, stage.state, stage.rerun, stage.returns])).toEqual([
      ["Fix", "launching", false, 0],
      ["Test", "to_run_again", false, 0],
      ["Verify", "to_run_again", false, 0],
      ["Review", "to_run_again", false, 1],
    ]);
  });

  it("leaves a stage upstream of return_to handed off", () => {
    let state = handOff(started(step(start(chain), { type: "send" }).state, "Fix"), "Fix").state;
    state = started(handOff(started(state, "Test"), "Test").state, "Review");
    const { state: returned, actions } = step(state, {
      type: "return",
      role: "Review",
      sessionId: "s-review-1",
      items: [1],
      note: "The test checks the wrong total.",
    });
    expect(launches(actions)).toEqual([["Test", 2]]);
    const launch = actions.find((action) => action.type === "launch");
    expect(launch?.type === "launch" && launch.notes.map((note) => [note.role, note.kind])).toEqual([
      ["Fix", "handoff"],
      ["Review", "return"],
    ]);
    expect(returned.stages.map((stage) => [stage.role, stage.state])).toEqual([
      ["Fix", "handed_off"],
      ["Test", "launching"],
      ["Review", "to_run_again"],
    ]);
  });

  it("stops and asks the operator when a stage whose file says stop finds unmet items", () => {
    const running = started(step(start(), { type: "send" }).state, "Fix");
    const { state, actions } = step(running, {
      type: "return",
      role: "Fix",
      sessionId: "s-fix-1",
      items: [1],
      note: "The bug is in a vendored file.",
    });
    const hold = {
      role: "Fix",
      reason: "stage_stopped",
      detail: "Stage Fix found unmet items, and its file says stop and ask you.",
    };
    expect(actions).toEqual([emit("Fix", "s-fix-1"), { type: "hold", hold }]);
    expect(state.holds).toEqual([hold]);
    expect(record(state, "Fix")).toMatchObject({ state: "held", runs: [{ outcome: "held" }] });
  });

  it("parks the work order once a stage has used max_returns", () => {
    let state = atTest();
    for (let round = 1; round <= 2; round++) {
      state = step(state, { type: "return", role: "Test", sessionId: `s-test-${round}`, items: [1], note: "" }).state;
      state = started(handOff(started(state, "Fix"), "Fix").state, "Test");
    }
    const { state: parked, actions } = step(state, {
      type: "return",
      role: "Test",
      sessionId: "s-test-3",
      items: [1],
      note: "Still no failing test.",
    });
    const hold = {
      role: "Test",
      reason: "returns_exhausted",
      detail: "Stage Test reached max_returns = 2 and cannot send the work back to Fix again.",
    };
    expect(actions).toEqual([emit("Test", "s-test-3"), { type: "hold", hold }]);
    expect(parked.holds).toEqual([hold]);
    expect(record(parked, "Test")).toMatchObject({ state: "held", returns: 2 });
    expect(record(parked, "Test").runs.at(-1)?.outcome).toBe("held");
    expect(parked.status).toBe("in_progress");
  });
});

describe("advanceWorkflow: session_ended and launch_failed", () => {
  it("holds a stage whose session ended without a handoff or a return", () => {
    const running = started(step(start(), { type: "send" }).state, "Fix");
    const { state, actions } = step(running, { type: "session_ended", role: "Fix", sessionId: "s-fix-1" });
    const hold = {
      role: "Fix",
      reason: "no_handoff",
      detail: "The session s-fix-1 ended without a handoff or a return.",
    };
    expect(actions).toEqual([emit("Fix", "s-fix-1"), { type: "hold", hold }]);
    expect(record(state, "Fix")).toMatchObject({ state: "held", runs: [{ outcome: "held", note: null }] });
  });

  it("holds a stage whose launch failed, with the screened reason, and sends no event for it", () => {
    const sent = step(start(), { type: "send" }).state;
    const { state, actions } = step(sent, {
      type: "launch_failed",
      role: "Fix",
      run: 1,
      reason: "The harness is offline.\u001b",
    });
    const hold = { role: "Fix", reason: "launch_failed", detail: "The harness is offline." };
    expect(actions).toEqual([{ type: "hold", hold }]);
    expect(record(state, "Fix")).toMatchObject({ state: "held", runs: [{ outcome: "launch_failed", sessionId: null }] });
  });

  it("refuses a launch failure for a run that is not waiting to start", () => {
    const sent = step(start(), { type: "send" }).state;
    expect(refused(sent, { type: "launch_failed", role: "Deploy", run: 1, reason: "" }).code).toBe("unknown_stage");
    expect(refused(sent, { type: "launch_failed", role: "Test", run: 1, reason: "" })).toEqual({
      code: "not_launching",
      message: "Stage Test has no run 1 waiting to start.",
    });
    expect(refused(sent, { type: "launch_failed", role: "Fix", run: 2, reason: "" }).code).toBe("not_launching");
    const running = started(sent, "Fix");
    expect(refused(running, { type: "launch_failed", role: "Fix", run: 1, reason: "" }).code).toBe("not_launching");
  });
});

describe("advanceWorkflow: a verify stage", () => {
  it("holds for the operator when no gateway check ran", () => {
    const { state, actions } = handOff(atVerify(), "Verify", "Both criteria hold.");
    const hold = { role: "Verify", reason: "verify_refused", detail: "No gateway check ran for the verify session." };
    expect(actions).toEqual([emit("Verify", "s-verify-1"), { type: "hold", hold }]);
    expect(record(state, "Verify").runs[0]).toMatchObject({
      outcome: "held",
      note: { kind: "handoff", text: "Both criteria hold." },
    });
    expect(record(state, "Review").state).toBe("waiting");
  });

  it("holds with every problem the gateway check found", () => {
    const refusedModels: VerifyAdmission = {
      admitted: false,
      problems: [
        {
          code: "not_contained",
          sessionId: "s-verify-1",
          message: "Verify session s-verify-1 ran at the harness tier. A verify stage runs contained.",
        },
        {
          code: "shared_model",
          sessionId: "s-verify-1",
          message:
            "Verify session s-verify-1 used build-a, which a build stage also used. A verify stage runs on a model no build stage used.",
        },
      ],
    };
    const { state } = handOff(atVerify(), "Verify", "", refusedModels);
    expect(state.holds).toEqual([
      {
        role: "Verify",
        reason: "verify_refused",
        detail:
          "Verify session s-verify-1 ran at the harness tier. A verify stage runs contained. Verify session s-verify-1 used build-a, which a build stage also used. A verify stage runs on a model no build stage used.",
      },
    ]);
  });

  it("hands off to Review once the gateway check admits it", () => {
    const { actions } = handOff(atVerify(), "Verify", "Both criteria hold.", ADMITTED);
    expect(actions).toEqual([
      emit("Verify", "s-verify-1"),
      {
        type: "launch",
        role: "Review",
        run: 1,
        launchId: "wo-1:stage-4:run-1",
        notes: [
          { role: "Verify", run: 1, sessionId: "s-verify-1", kind: "handoff", text: "Both criteria hold.", items: [] },
        ],
      },
    ]);
  });
});

describe("advanceWorkflow: accept", () => {
  const allow: AutonomyDecision = { decision: "allow", reasons: ["autonomy-level-2"], errors: [] };
  const waiting = (): Step => handOff(atReview(), "Review");

  it("waits on the operator once every stage has handed off", () => {
    const { state, actions } = waiting();
    expect(actions).toEqual([emit("Review", "s-review-1"), { type: "await_accept", by: "operator", operator: "priya" }]);
    expect(state.status).toBe("waiting_on_you");
  });

  it("refuses to accept before the work order waits on you", () => {
    expect(refused(atReview(), { type: "accept", principal: { kind: "operator", handle: "priya" } })).toEqual({
      code: "not_waiting",
      message: "Work order wo-1 is not waiting on you.",
    });
  });

  it("lets the work order's operator accept, and nobody else", () => {
    const { state } = waiting();
    expect(refused(state, { type: "accept", principal: { kind: "operator", handle: "sam" } })).toEqual({
      code: "not_operator",
      message: "Only priya, the work order's operator, may accept it.",
    });
    const principal: AcceptPrincipal = { kind: "operator", handle: "priya" };
    const accepted = step(state, { type: "accept", principal });
    expect(accepted.actions).toEqual([{ type: "accepted", principal }]);
    expect(accepted.state).toMatchObject({ status: "accepted", acceptedBy: principal });
    expect(refused(accepted.state, { type: "accept", principal }).code).toBe("not_waiting");
  });

  it("lets Oxagen accept for the operator at level 2 on a proven record Cedar allows, under by = operator", () => {
    const { state } = waiting();
    expect(state.workflow.accept.by).toBe("operator");
    const principal: AcceptPrincipal = {
      kind: "autonomy",
      operator: "priya",
      level: 2,
      verdict: "proven",
      decision: allow,
    };
    const accepted = step(state, { type: "accept", principal });
    expect(accepted.state).toMatchObject({ status: "accepted", acceptedBy: principal });
  });

  it("refuses an autonomy accept for another operator, and names every reason it cannot accept", () => {
    const { state } = waiting();
    const autonomy = (fields: Partial<Extract<AcceptPrincipal, { kind: "autonomy" }>>): WorkflowEvent => ({
      type: "accept",
      principal: { kind: "autonomy", operator: "priya", level: 2, verdict: "proven", decision: allow, ...fields },
    });
    expect(refused(state, autonomy({ operator: "sam" }))).toEqual({
      code: "not_operator",
      message: "Oxagen may accept only for priya, the work order's operator.",
    });
    expect(
      refused(state, autonomy({ level: 1, verdict: "held", decision: { decision: "deny", reasons: [], errors: [] } })),
    ).toEqual({
      code: "autonomy_denied",
      message:
        "Oxagen cannot accept for the operator: the scope is at level 1, below level 2, the done record is held, not proven, Cedar denied work.merge.",
    });
    expect(refused(state, autonomy({ verdict: "broken" })).message).toBe(
      "Oxagen cannot accept for the operator: the done record is broken, not proven.",
    );
  });
});

describe("advanceWorkflow: a workflow that forks", () => {
  it("marks runs a return made stale, discards their result, and runs them again", () => {
    let state = started(step(start(fork), { type: "send" }).state, "Fix");
    let next = handOff(state, "Fix");
    expect(launches(next.actions)).toEqual([
      ["Test", 1],
      ["Docs", 1],
    ]);
    state = started(next.state, "Test");

    // Test sends the work back while Docs is still launching.
    next = step(state, { type: "return", role: "Test", sessionId: "s-test-1", items: [1], note: "" });
    expect(launches(next.actions)).toEqual([["Fix", 2]]);
    expect(record(next.state, "Docs")).toMatchObject({ state: "launching", rerun: true });
    expect(record(next.state, "Review")).toMatchObject({ state: "waiting", rerun: false });

    // A launch that fails clears the flag and holds the stage.
    const failed = step(next.state, { type: "launch_failed", role: "Docs", run: 1, reason: "No harness." });
    expect(record(failed.state, "Docs")).toMatchObject({ state: "held", rerun: false });

    // Docs starts. Its return from the stale run closes the run and is not counted.
    state = started(next.state, "Docs");
    next = step(state, { type: "return", role: "Docs", sessionId: "s-docs-1", items: [2], note: "Stale." });
    expect(next.actions).toEqual([emit("Docs", "s-docs-1")]);
    expect(record(next.state, "Docs")).toMatchObject({ state: "to_run_again", returns: 0, rerun: false });
    expect(record(next.state, "Docs").runs[0]).toMatchObject({ outcome: "superseded", note: null });
    expect(record(next.state, "Fix").pendingReturns).toEqual([]);

    // Fix hands off again, and both branches run again.
    next = handOff(started(next.state, "Fix"), "Fix");
    expect(launches(next.actions)).toEqual([
      ["Test", 2],
      ["Docs", 2],
    ]);
    state = started(started(next.state, "Test"), "Docs");

    // A second return while Docs is running marks that run stale too.
    next = step(state, { type: "return", role: "Test", sessionId: "s-test-2", items: [1], note: "" });
    expect(record(next.state, "Docs")).toMatchObject({ state: "running", rerun: true });
    next = handOff(next.state, "Docs");
    expect(next.actions).toEqual([emit("Docs", "s-docs-2")]);
    expect(record(next.state, "Docs").runs[1]?.outcome).toBe("superseded");
    expect(record(next.state, "Docs").state).toBe("to_run_again");
  });

  it("launches no stage while a hold stands", () => {
    let state = handOff(started(step(start(fork), { type: "send" }).state, "Fix"), "Fix").state;
    state = started(started(state, "Test"), "Docs");
    let next = step(state, { type: "session_ended", role: "Docs", sessionId: "s-docs-1" });
    expect(next.state.holds).toHaveLength(1);

    // Test hands off. Review needs only Test, and still does not launch.
    next = handOff(next.state, "Test");
    expect(next.actions).toEqual([emit("Test", "s-test-1")]);
    expect(record(next.state, "Test").state).toBe("handed_off");
    expect(record(next.state, "Review").state).toBe("waiting");
  });
});
