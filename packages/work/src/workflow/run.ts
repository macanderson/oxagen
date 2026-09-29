// run.ts: the pure state machine that moves one work order through its
// workflow's stages.
//
// tasks-spec.md §10.3 sets the sequence. A stage runs when every stage it needs
// has handed off. hand_off_work_order closes a stage's run with a note, which
// reaches the next stage as quoted evidence. return_work_order sends the work
// back to the role the file names and counts the return. When a stage has used
// its returns, the work order parks for the operator. After the last stage
// hands off, the work order waits on you, and [accept] decides who may accept.
//
// advanceWorkflow takes one event and returns the next state and the actions
// the runner performs: launch a stage run, send work/stage.completed, ask the
// operator, or wait for acceptance. It reads no clock and no store, so a test
// can drive a whole work order and a replayed event reads the same result.
//
// The work order's status uses the names of work-in-flight-spec.md §8.8, the
// states evaluateWorkOrder returns. A hold is a flag beside the status, as §8.8
// treats a parked thread, never a status of its own. The runner never sets
// `stopped`: §8.8 reserves it for a person who stops the work order. While any
// hold stands, the work order launches no stage, which is what "the work order
// stops and asks its operator" means here. Runs already going may still finish.
import type { DoneVerdict } from "@oxagen/done-record";
import type { AutonomyDecision } from "../autonomy/autonomy-allows";
import type { WorkOrderState } from "../plan/evaluate-work-order";
import type { AutonomyLevel } from "../types";
import { downstreamOf } from "./graph";
import { type QuotedNote, stageLaunchId } from "./launch";
import type { ResolvedStage, ResolvedWorkflow } from "./parse";
import type { VerifyAdmission } from "./verify";

/** The event every closed stage run sends. Mirrors @oxagen/inngest-functions' WORK_STAGE_COMPLETED_EVENT. */
export const WORK_STAGE_COMPLETED_EVENT = "work/stage.completed" as const;

/** The data work/stage.completed carries, as the Shared contract names it. */
export interface WorkStageCompletedData {
  org_id: string;
  workspace_id: string;
  work_order_id: string;
  role: string;
  session_id: string;
}

/** The work order statuses this machine sets, a subset of evaluateWorkOrder's states. */
export type WorkflowStatus = Extract<WorkOrderState, "queued" | "sent" | "in_progress" | "waiting_on_you" | "accepted">;

/** Where one stage stands. */
export const STAGE_STATES = ["waiting", "launching", "running", "handed_off", "to_run_again", "held"] as const;
export type StageState = (typeof STAGE_STATES)[number];

/** How a stage run closed. */
export const RUN_OUTCOMES = ["handed_off", "returned", "superseded", "held", "launch_failed"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Why a stage waits for the operator. */
export const HOLD_REASONS = [
  "returns_exhausted",
  "stage_stopped",
  "verify_refused",
  "no_handoff",
  "launch_failed",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** One run of one stage. */
export interface StageRun {
  run: number;
  launchId: string;
  /** The harness session, or null until the harness reports it. */
  sessionId: string | null;
  /** How the run closed, or null while it is open. */
  outcome: RunOutcome | null;
  /** The note the run handed off or returned with. */
  note: QuotedNote | null;
}

export interface StageRecord {
  role: string;
  state: StageState;
  runs: StageRun[];
  /** How many times this stage has sent work back. */
  returns: number;
  /** True when a return upstream made the open run's evidence stale. */
  rerun: boolean;
  /** Return notes addressed to this stage, delivered with its next run. */
  pendingReturns: QuotedNote[];
}

/** A stage that waits for the operator. A flag beside the status. */
export interface Hold {
  role: string;
  reason: HoldReason;
  detail: string;
}

/** Who accepts the work. */
export type AcceptPrincipal =
  | { kind: "operator"; handle: string }
  | {
      /** Oxagen acting for the operator under the scope's autonomy level (lane A2). */
      kind: "autonomy";
      operator: string;
      level: AutonomyLevel;
      verdict: DoneVerdict;
      decision: AutonomyDecision;
    };

export interface WorkflowState {
  workOrderId: string;
  orgId: string;
  workspaceId: string;
  /** The operator the work order belongs to, who is asked and who accepts. */
  operator: string;
  workflow: ResolvedWorkflow;
  status: WorkflowStatus;
  stages: StageRecord[];
  holds: Hold[];
  acceptedBy: AcceptPrincipal | null;
}

export type WorkflowEvent =
  | { type: "send" }
  | { type: "stage_started"; role: string; run: number; sessionId: string }
  | { type: "hand_off"; role: string; sessionId: string; note: string; admission?: VerifyAdmission }
  | { type: "return"; role: string; sessionId: string; items: number[]; note: string }
  | { type: "session_ended"; role: string; sessionId: string }
  | { type: "launch_failed"; role: string; run: number; reason: string }
  | { type: "accept"; principal: AcceptPrincipal };

export type WorkflowAction =
  | { type: "launch"; role: string; run: number; launchId: string; notes: QuotedNote[] }
  | { type: "emit"; name: typeof WORK_STAGE_COMPLETED_EVENT; data: WorkStageCompletedData }
  | { type: "hold"; hold: Hold }
  | { type: "await_accept"; by: ResolvedWorkflow["accept"]["by"]; operator: string }
  | { type: "accepted"; principal: AcceptPrincipal };

export const REFUSAL_CODES = [
  "already_sent",
  "unknown_stage",
  "unknown_session",
  "not_launching",
  "stale_run",
  "not_running",
  "bad_items",
  "not_waiting",
  "not_operator",
  "autonomy_denied",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type AdvanceResult =
  | { ok: true; state: WorkflowState; actions: WorkflowAction[] }
  | { ok: false; code: RefusalCode; message: string };

/** The longest note a stage may pass on, in characters. */
export const MAX_NOTE_LENGTH = 8000;

/** The level at which Oxagen may accept for the operator (agent-work-spec.html, Autonomy levels). */
export const AUTONOMY_ACCEPT_LEVEL = 2;

/**
 * Screen a note before it is stored. A note is data from another agent: drop
 * control characters other than tab and newline, and cap its length.
 */
export function screenNote(text: string): string {
  let out = "";
  for (let i = 0; i < text.length && out.length < MAX_NOTE_LENGTH; i++) {
    const code = text.charCodeAt(i);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control || code === 0x09 || code === 0x0a) out += text[i];
  }
  return out;
}

export interface NewWorkflowState {
  workOrderId: string;
  orgId: string;
  workspaceId: string;
  operator: string;
  workflow: ResolvedWorkflow;
}

/** A work order's state before it is sent. */
export function initialWorkflowState(input: NewWorkflowState): WorkflowState {
  return {
    ...input,
    status: "queued",
    stages: input.workflow.stages.map((stage) => ({
      role: stage.role,
      state: "waiting",
      runs: [],
      returns: 0,
      rerun: false,
      pendingReturns: [],
    })),
    holds: [],
    acceptedBy: null,
  };
}

const refuse = (code: RefusalCode, message: string): AdvanceResult => ({ ok: false, code, message });

/** Apply one event. Never mutates `state`. */
export function advanceWorkflow(state: WorkflowState, event: WorkflowEvent): AdvanceResult {
  const next = structuredClone(state);
  const actions: WorkflowAction[] = [];
  const machine = new Machine(next, actions);

  switch (event.type) {
    case "send": {
      if (next.status !== "queued") return refuse("already_sent", `Work order ${next.workOrderId} was already sent.`);
      next.status = "sent";
      machine.schedule();
      break;
    }
    case "stage_started": {
      const record = machine.record(event.role);
      if (record === null) return machine.unknownStage(event.role);
      if (record.state !== "launching") {
        return refuse("not_launching", `Stage ${event.role} has no run waiting to start.`);
      }
      const latest = record.runs.at(-1) as StageRun;
      if (latest.run !== event.run) {
        return refuse("stale_run", `Stage ${event.role} is on run ${latest.run}, not run ${event.run}.`);
      }
      latest.sessionId = event.sessionId;
      record.state = "running";
      if (next.status === "sent") next.status = "in_progress";
      break;
    }
    case "hand_off":
    case "return":
    case "session_ended": {
      const found = machine.openRun(event.role, event.sessionId);
      if (!found.ok) return found.refusal;
      if (found.run === null) {
        // The run already closed. A late session end changes nothing, and a
        // second handoff or return from the same session is refused.
        if (event.type === "session_ended") break;
        return refuse("not_running", `The run for session ${event.sessionId} already closed.`);
      }
      const { record, run } = found;
      if (event.type === "return" && !validItems(event.items)) {
        return refuse("bad_items", "A return names one or more done record item numbers, each a whole number from 1.");
      }
      if (record.rerun) {
        // A return upstream replaced this run's inputs. Its result is stale, so
        // the stage runs again, and a return from it is not counted.
        machine.close(record, run, "superseded", null);
        record.state = "to_run_again";
        machine.schedule();
        break;
      }
      if (event.type === "hand_off") machine.handOff(record, run, event.note, event.admission);
      else if (event.type === "return") machine.sendBack(record, run, event.items, event.note);
      else {
        machine.close(record, run, "held", null);
        machine.hold(record, "no_handoff", `The session ${run.sessionId} ended without a handoff or a return.`);
      }
      break;
    }
    case "launch_failed": {
      const record = machine.record(event.role);
      if (record === null) return machine.unknownStage(event.role);
      const latest = record.runs.at(-1) as StageRun;
      if (record.state !== "launching" || latest.run !== event.run) {
        return refuse("not_launching", `Stage ${event.role} has no run ${event.run} waiting to start.`);
      }
      latest.outcome = "launch_failed";
      record.rerun = false;
      machine.hold(record, "launch_failed", screenNote(event.reason));
      break;
    }
    case "accept": {
      if (next.status !== "waiting_on_you") {
        return refuse("not_waiting", `Work order ${next.workOrderId} is not waiting on you.`);
      }
      const denied = acceptRefusal(next, event.principal);
      if (denied !== null) return denied;
      next.status = "accepted";
      next.acceptedBy = event.principal;
      actions.push({ type: "accepted", principal: event.principal });
      break;
    }
  }
  return { ok: true, state: next, actions };
}

function validItems(items: readonly number[]): boolean {
  return items.length > 0 && items.every((item) => Number.isInteger(item) && item >= 1);
}

/** Who may accept. An operator accepts their own work order under either `by`. */
function acceptRefusal(state: WorkflowState, principal: AcceptPrincipal): AdvanceResult | null {
  if (principal.kind === "operator") {
    if (principal.handle === state.operator) return null;
    return refuse("not_operator", `Only ${state.operator}, the work order's operator, may accept it.`);
  }
  if (principal.operator !== state.operator) {
    return refuse("not_operator", `Oxagen may accept only for ${state.operator}, the work order's operator.`);
  }
  // Level 2 and higher may accept for the operator, under by = "operator" as
  // well as by = "proven", and only a proven record that Cedar allows.
  const reasons: string[] = [];
  if (principal.level < AUTONOMY_ACCEPT_LEVEL) reasons.push(`the scope is at level ${principal.level}, below level 2`);
  if (principal.verdict !== "proven") reasons.push(`the done record is ${principal.verdict}, not proven`);
  if (principal.decision.decision !== "allow") reasons.push("Cedar denied work.merge");
  if (reasons.length === 0) return null;
  return refuse("autonomy_denied", `Oxagen cannot accept for the operator: ${reasons.join(", ")}.`);
}

type OpenRun =
  | { ok: false; refusal: AdvanceResult }
  | { ok: true; run: null }
  | { ok: true; record: StageRecord; run: StageRun };

/** The mutable steps of one transition, over a cloned state. */
class Machine {
  constructor(
    private readonly state: WorkflowState,
    private readonly actions: WorkflowAction[],
  ) {}

  record(role: string): StageRecord | null {
    return this.state.stages.find((stage) => stage.role === role) ?? null;
  }

  stage(role: string): ResolvedStage {
    return this.state.workflow.stages.find((stage) => stage.role === role) as ResolvedStage;
  }

  unknownStage(role: string): AdvanceResult {
    return refuse("unknown_stage", `Workflow ${this.state.workflow.slug} has no stage ${role}.`);
  }

  /** The run a session belongs to. A closed run reads as `run: null`. */
  openRun(role: string, sessionId: string): OpenRun {
    const record = this.record(role);
    if (record === null) return { ok: false, refusal: this.unknownStage(role) };
    const run = record.runs.find((candidate) => candidate.sessionId === sessionId);
    if (run === undefined) {
      return {
        ok: false,
        refusal: refuse("unknown_session", `Session ${sessionId} is not a run of stage ${role}.`),
      };
    }
    if (run.outcome !== null) return { ok: true, run: null };
    return { ok: true, record, run };
  }

  /** Close a run and send work/stage.completed for its session. */
  close(record: StageRecord, run: StageRun, outcome: RunOutcome, note: QuotedNote | null): void {
    run.outcome = outcome;
    run.note = note;
    record.rerun = false;
    this.actions.push({
      type: "emit",
      name: WORK_STAGE_COMPLETED_EVENT,
      data: {
        org_id: this.state.orgId,
        workspace_id: this.state.workspaceId,
        work_order_id: this.state.workOrderId,
        role: record.role,
        session_id: run.sessionId as string,
      },
    });
  }

  hold(record: StageRecord, reason: HoldReason, detail: string): void {
    record.state = "held";
    const hold: Hold = { role: record.role, reason, detail };
    this.state.holds.push(hold);
    this.actions.push({ type: "hold", hold });
  }

  note(record: StageRecord, run: StageRun, kind: QuotedNote["kind"], text: string, items: number[]): QuotedNote {
    return {
      role: record.role,
      run: run.run,
      sessionId: run.sessionId as string,
      kind,
      text: screenNote(text),
      items,
    };
  }

  handOff(record: StageRecord, run: StageRun, text: string, admission: VerifyAdmission | undefined): void {
    const note = this.note(record, run, "handoff", text, []);
    if (this.stage(record.role).kind === "verify" && admission?.admitted !== true) {
      this.close(record, run, "held", note);
      const detail =
        admission === undefined
          ? "No gateway check ran for the verify session."
          : admission.problems.map((problem) => problem.message).join(" ");
      this.hold(record, "verify_refused", detail);
      return;
    }
    this.close(record, run, "handed_off", note);
    record.state = "handed_off";
    this.schedule();
  }

  sendBack(record: StageRecord, run: StageRun, items: number[], text: string): void {
    const stage = this.stage(record.role);
    const note = this.note(record, run, "return", text, [...new Set(items)].sort((a, b) => a - b));
    if (stage.returnTo === null) {
      this.close(record, run, "held", note);
      this.hold(record, "stage_stopped", `Stage ${record.role} found unmet items, and its file says stop and ask you.`);
      return;
    }
    if (record.returns >= stage.maxReturns) {
      this.close(record, run, "held", note);
      this.hold(
        record,
        "returns_exhausted",
        `Stage ${record.role} reached max_returns = ${stage.maxReturns} and cannot send the work back to ${stage.returnTo} again.`,
      );
      return;
    }
    record.returns += 1;
    this.close(record, run, "returned", note);
    const target = this.record(stage.returnTo) as StageRecord;
    target.pendingReturns.push(note);
    // The returning stage lies downstream of return_to. Its run just closed, so
    // it goes to run again before the loop, which would otherwise read it as
    // running and mark its next run stale.
    record.state = "to_run_again";
    const affected = downstreamOf(this.state.workflow.stages, stage.returnTo);
    affected.add(stage.returnTo);
    for (const other of this.state.stages) {
      if (!affected.has(other.role)) continue;
      if (other.state === "handed_off") other.state = "to_run_again";
      else if (other.state === "running" || other.state === "launching") other.rerun = true;
      // A waiting or held stage keeps its state. It launches once its needs hand off again.
    }
    this.schedule();
  }

  /**
   * Launch every stage whose needs have all handed off, then wait for
   * acceptance once every stage has. A stage downstream of one that runs again
   * never launches early, because that stage no longer reads handed_off.
   */
  schedule(): void {
    if (this.state.holds.length > 0) return;
    const byRole = new Map(this.state.stages.map((record) => [record.role, record]));
    for (const stage of this.state.workflow.stages) {
      const record = byRole.get(stage.role) as StageRecord;
      if (record.state !== "waiting" && record.state !== "to_run_again") continue;
      if (!stage.needs.every((need) => (byRole.get(need) as StageRecord).state === "handed_off")) continue;
      this.launch(stage, record, byRole);
    }
    if (this.state.stages.every((record) => record.state === "handed_off")) {
      this.state.status = "waiting_on_you";
      this.actions.push({ type: "await_accept", by: this.state.workflow.accept.by, operator: this.state.operator });
    }
  }

  private launch(stage: ResolvedStage, record: StageRecord, byRole: Map<string, StageRecord>): void {
    const run = record.runs.length + 1;
    const launchId = stageLaunchId(this.state.workOrderId, stage.index, run);
    const notes: QuotedNote[] = [];
    for (const need of stage.needs) {
      // A stage reads handed_off only after a run handed off with a note.
      const runs = (byRole.get(need) as StageRecord).runs;
      const handedOff = [...runs].reverse().find((r) => r.outcome === "handed_off") as StageRun;
      notes.push(handedOff.note as QuotedNote);
    }
    notes.push(...record.pendingReturns);
    record.pendingReturns = [];
    record.runs.push({ run, launchId, sessionId: null, outcome: null, note: null });
    record.state = "launching";
    this.actions.push({ type: "launch", role: stage.role, run, launchId, notes });
  }
}
