// runner.ts: the workflow runner, which applies one event to a stored work
// order and performs the actions advanceWorkflow returns.
//
// Every side effect goes through a port, so the runner runs the same against
// the database and a harness as it does against the fakes in its tests:
//
// - WorkOrderStore loads a work order and saves it only when nobody saved first.
// - AgentFiles reads the agent file a stage names, for its operator and harness.
// - HarnessLauncher sends an arp.launch/0.1 request and returns the session.
// - EventSink sends work/stage.completed.
// - GatewayRecords returns what the gateway recorded about one session.
// - OperatorQueue asks the operator about a hold, and says the work waits on them.
// - AutonomyGate returns the scope's level, the record's verdict, and Cedar's
//   answer when Oxagen accepts for the operator (lane A2).
//
// The runner saves the next state before it performs any action. A launch that
// is retried sends the same launch_id, which ARP treats as the same request.
//
// The MCP tools hand_off_work_order, return_work_order, and accept_work_order
// call handOff, returnWork, and accept. The tool names the session it runs in,
// and the runner finds the stage from the session, so a caller cannot act for
// another stage.
import type { DoneVerdict } from "@oxagen/done-record";
import type { AutonomyDecision } from "../autonomy/autonomy-allows";
import type { AutonomyLevel } from "../types";
import { type AgentFileFacts, buildStageLaunch, type StageLaunch } from "./launch";
import type { ResolvedStage } from "./parse";
import {
  type AcceptPrincipal,
  advanceWorkflow,
  type Hold,
  type RefusalCode,
  type WorkflowAction,
  type WorkflowEvent,
  type WorkflowState,
  type WorkStageCompletedData,
  type WORK_STAGE_COMPLETED_EVENT,
} from "./run";
import { admitVerifyStage, type GatewaySession, type VerifyAdmission } from "./verify";

/** A work order as the store holds it. */
export interface StoredWorkOrder {
  state: WorkflowState;
  /** Bumped on every save. */
  version: number;
  /** The work order's brief, which every stage receives. */
  brief: string;
  workItemId: string;
  /** The done record's lock digest, or null before the record locks. */
  doneRecordDigest: string | null;
}

export interface WorkOrderStore {
  load(workOrderId: string): Promise<StoredWorkOrder | null>;
  /** Save when the stored version still equals `expectedVersion`. False when another writer saved first. */
  save(workOrderId: string, state: WorkflowState, expectedVersion: number): Promise<boolean>;
}

export interface AgentFiles {
  /** The agent file for a lineage, or null when the workspace has none. */
  read(lineage: string): Promise<AgentFileFacts | null>;
}

export interface HarnessLauncher {
  launch(request: StageLaunch): Promise<{ sessionId: string }>;
}

export interface EventSink {
  send(name: typeof WORK_STAGE_COMPLETED_EVENT, data: WorkStageCompletedData): Promise<void>;
}

export interface GatewayRecords {
  /** What the gateway recorded about a session, or null when it has no record. */
  session(sessionId: string): Promise<GatewaySession | null>;
}

export interface OperatorQueue {
  /** Ask the operator about a stage that waits for them. */
  ask(workOrderId: string, operator: string, hold: Hold): Promise<void>;
  /** Tell the operator the work order waits on them to accept. */
  waitingOnYou(workOrderId: string, operator: string, by: "operator" | "proven"): Promise<void>;
}

export interface AutonomyGate {
  /** The facts that decide whether Oxagen may accept for the operator now. */
  forAccept(
    workOrderId: string,
    operator: string,
  ): Promise<{ level: AutonomyLevel; verdict: DoneVerdict; decision: AutonomyDecision }>;
}

export interface WorkflowRunnerPorts {
  store: WorkOrderStore;
  agents: AgentFiles;
  launcher: HarnessLauncher;
  events: EventSink;
  gateway: GatewayRecords;
  operators: OperatorQueue;
  autonomy: AutonomyGate;
}

/** The input of hand_off_work_order. */
export interface HandOffWorkOrderInput {
  workOrderId: string;
  /** The session the calling agent runs in. */
  sessionId: string;
  /** The handoff note, passed to the next stage as quoted evidence. */
  note: string;
}

/** The input of return_work_order. */
export interface ReturnWorkOrderInput {
  workOrderId: string;
  sessionId: string;
  /** The done record item numbers the earlier stage left unmet. */
  items: number[];
  note: string;
}

/** The input of accept_work_order. */
export interface AcceptWorkOrderInput {
  workOrderId: string;
  /** The operator accepting, or Oxagen accepting for them under the scope's autonomy level. */
  by: { kind: "operator"; handle: string } | { kind: "autonomy" };
}

/** What each runner call returns: the work order's state after the call's own event. */
export interface WorkflowRunnerResult {
  state: WorkflowState;
  actions: WorkflowAction[];
}

export type WorkflowRunnerErrorCode = RefusalCode | "unknown_work_order" | "version_conflict";

/** A call the runner refused. The code is stable. The message says what to do. */
export class WorkflowRunnerError extends Error {
  readonly code: WorkflowRunnerErrorCode;

  constructor(code: WorkflowRunnerErrorCode, message: string) {
    super(message);
    this.name = "WorkflowRunnerError";
    this.code = code;
  }
}

/** The stage whose run carries a session, or null. */
export function roleOfSession(state: WorkflowState, sessionId: string): string | null {
  const record = state.stages.find((stage) => stage.runs.some((run) => run.sessionId === sessionId));
  return record?.role ?? null;
}

export class WorkflowRunner {
  constructor(private readonly ports: WorkflowRunnerPorts) {}

  /** Send the work order. The first stage launches. */
  start(workOrderId: string): Promise<WorkflowRunnerResult> {
    return this.apply(workOrderId, () => ({ type: "send" }));
  }

  /** hand_off_work_order. A verify stage's handoff is checked against the gateway first. */
  handOff(input: HandOffWorkOrderInput): Promise<WorkflowRunnerResult> {
    return this.apply(input.workOrderId, async (stored) => {
      const role = this.sessionRole(stored.state, input.sessionId);
      const event: Extract<WorkflowEvent, { type: "hand_off" }> = {
        type: "hand_off",
        role,
        sessionId: input.sessionId,
        note: input.note,
      };
      if (stageOf(stored.state, role).kind === "verify") {
        event.admission = await this.admitVerify(stored.state, input.sessionId);
      }
      return event;
    });
  }

  /** return_work_order. */
  returnWork(input: ReturnWorkOrderInput): Promise<WorkflowRunnerResult> {
    return this.apply(input.workOrderId, (stored) => ({
      type: "return",
      role: this.sessionRole(stored.state, input.sessionId),
      sessionId: input.sessionId,
      items: input.items,
      note: input.note,
    }));
  }

  /** A stage's session ended. A session that ended without a handoff or a return holds its stage. */
  sessionEnded(workOrderId: string, sessionId: string): Promise<WorkflowRunnerResult> {
    return this.apply(workOrderId, (stored) => ({
      type: "session_ended",
      role: this.sessionRole(stored.state, sessionId),
      sessionId,
    }));
  }

  /** accept_work_order. */
  accept(input: AcceptWorkOrderInput): Promise<WorkflowRunnerResult> {
    return this.apply(input.workOrderId, async (stored) => {
      let principal: AcceptPrincipal;
      if (input.by.kind === "operator") principal = input.by;
      else {
        const operator = stored.state.operator;
        const facts = await this.ports.autonomy.forAccept(input.workOrderId, operator);
        principal = { kind: "autonomy", operator, ...facts };
      }
      return { type: "accept", principal };
    });
  }

  private sessionRole(state: WorkflowState, sessionId: string): string {
    const role = roleOfSession(state, sessionId);
    if (role === null) {
      throw new WorkflowRunnerError(
        "unknown_session",
        `Session ${sessionId} is not a stage run of work order ${state.workOrderId}.`,
      );
    }
    return role;
  }

  /** Read the gateway's records for the verify session and every build run. */
  private async admitVerify(state: WorkflowState, verifySessionId: string): Promise<VerifyAdmission> {
    const builds: { role: string; sessionId: string; record: GatewaySession | null }[] = [];
    for (const stage of state.workflow.stages) {
      if (stage.kind !== "build") continue;
      const record = state.stages.find((candidate) => candidate.role === stage.role);
      for (const run of record?.runs ?? []) {
        if (run.sessionId === null) continue;
        builds.push({ role: stage.role, sessionId: run.sessionId, record: await this.ports.gateway.session(run.sessionId) });
      }
    }
    const verify = await this.ports.gateway.session(verifySessionId);
    return admitVerifyStage({ verifySessionId, verify, builds });
  }

  private async apply(
    workOrderId: string,
    toEvent: (stored: StoredWorkOrder) => WorkflowEvent | Promise<WorkflowEvent>,
  ): Promise<WorkflowRunnerResult> {
    const stored = await this.ports.store.load(workOrderId);
    if (stored === null) {
      throw new WorkflowRunnerError("unknown_work_order", `No work order ${workOrderId} exists.`);
    }
    const event = await toEvent(stored);
    const result = advanceWorkflow(stored.state, event);
    if (!result.ok) throw new WorkflowRunnerError(result.code, result.message);
    if (!(await this.ports.store.save(workOrderId, result.state, stored.version))) {
      throw new WorkflowRunnerError(
        "version_conflict",
        `Work order ${workOrderId} changed while this call ran. Read it again and retry.`,
      );
    }
    for (const action of result.actions) await this.perform(stored, result.state, action);
    return { state: result.state, actions: result.actions };
  }

  private async perform(stored: StoredWorkOrder, state: WorkflowState, action: WorkflowAction): Promise<void> {
    switch (action.type) {
      case "emit":
        await this.ports.events.send(action.name, action.data);
        return;
      case "hold":
        await this.ports.operators.ask(state.workOrderId, state.operator, action.hold);
        return;
      case "await_accept":
        await this.ports.operators.waitingOnYou(state.workOrderId, state.operator, action.by);
        return;
      case "launch":
        await this.launch(stored, state, action);
        return;
      case "accepted":
        return;
    }
  }

  /** Launch one stage run, then record the session it started or why it did not start. */
  private async launch(
    stored: StoredWorkOrder,
    state: WorkflowState,
    action: Extract<WorkflowAction, { type: "launch" }>,
  ): Promise<void> {
    const event = await this.startRun(stored, state, action);
    await this.apply(state.workOrderId, () => event);
  }

  private async startRun(
    stored: StoredWorkOrder,
    state: WorkflowState,
    action: Extract<WorkflowAction, { type: "launch" }>,
  ): Promise<WorkflowEvent> {
    const stage = stageOf(state, action.role);
    try {
      const agent = await this.ports.agents.read(stage.agent);
      if (agent === null) throw new Error(`No agent file names ${stage.agent}.`);
      if (agent.operator !== state.operator) {
        // tasks-spec.md §10.4: every agent in a workflow is one the work order's operator operates.
        throw new Error(`Agent ${stage.agent} is operated by ${agent.operator}, not ${state.operator}.`);
      }
      const request = buildStageLaunch({
        workOrderId: state.workOrderId,
        workItemId: stored.workItemId,
        doneRecordDigest: stored.doneRecordDigest,
        brief: stored.brief,
        stages: state.workflow.stages,
        stage,
        run: action.run,
        agent,
        notes: action.notes,
      });
      const { sessionId } = await this.ports.launcher.launch(request);
      return { type: "stage_started", role: action.role, run: action.run, sessionId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { type: "launch_failed", role: action.role, run: action.run, reason };
    }
  }
}

function stageOf(state: WorkflowState, role: string): ResolvedStage {
  return state.workflow.stages.find((stage) => stage.role === role) as ResolvedStage;
}
