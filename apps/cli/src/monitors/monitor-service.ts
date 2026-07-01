/**
 * The background monitor service (pipeline Group 5 — agent to agent).
 *
 * Implements the `monitor_dispatch` tool from `monitor-tools.json`:
 * {@link BackgroundMonitorService.dispatch} spawns a background poll of a
 * long-running target (a GH Actions run, a pull request's checks, or a CI
 * job) and returns `{ subagentId, background: true }` immediately — it never
 * awaits the target's terminal state. The poll runs out of process, from the
 * coordinator's point of view: nothing about it holds the coordinator's turn
 * open, and a slow or never-terminating target cannot block `dispatch`.
 *
 * When the poll reaches a terminal state (succeeded/failed — never on an
 * intermediate check), the service builds a {@link MonitorReport} — including
 * the failure fix-assessment (`identifiedProblem`,
 * `canFixWithCommittedChanges`) on failure — logs it, and invokes every
 * handler registered with {@link BackgroundMonitorService.onReport}. Group 6
 * wires a handler that surfaces the report to the developer proactively; see
 * {@link surfaceReport} for the minimal default.
 */
import { getPollIntervalSeconds } from "./config.js";
import { defaultLogSink, type LogSink } from "./logging.js";
import { agentRegistry, type AgentHandle } from "../agent/agent-registry.js";
import type {
  MonitorDispatchInput,
  MonitorDispatchResult,
  MonitorReport,
  MonitorReportHandler,
  MonitorService,
  TargetPollResult,
  TargetPoller,
} from "./types.js";

/** Monotonic per-process counter so ids stay stable and collision-free without a UUID dependency. */
let subagentCounter = 0;

/** Default `subagentId` generator: `mon_<base36 timestamp>_<base36 counter>`. */
function defaultGenId(): string {
  subagentCounter = (subagentCounter + 1) % 1_000_000;
  return `mon_${Date.now().toString(36)}_${subagentCounter.toString(36)}`;
}

/** Default clock. Injectable so log timestamps are deterministic in tests. */
function defaultNowIso(): string {
  return new Date().toISOString();
}

/** Injectable dependencies for the {@link BackgroundMonitorService}. */
export interface MonitorServiceDeps {
  /**
   * Checks a target and resolves once it reaches a terminal state. Required —
   * there is no shell-out default wired in automatically; pass
   * {@link createGhTargetPoller} explicitly for the real GitHub-backed
   * implementation. Tests inject a poller that resolves immediately so
   * nothing ever sleeps.
   */
  poll: TargetPoller;
  /** Log sink for the dispatch/report lines. Defaults to the debug-log sink. */
  log?: LogSink;
  /** `subagentId` generator. Defaults to a monotonic per-process id. */
  genId?: () => string;
  /** Clock for log timestamps. Defaults to `new Date().toISOString()`. */
  nowIso?: () => string;
  /**
   * Registry the dispatched monitor registers itself into so it shows up in the
   * REPL's `/hud`. Defaults to the process-wide singleton; tests pass their own
   * (or `null` to opt out) to keep global HUD state out of unrelated assertions.
   */
  registry?: { register: (input: Parameters<typeof agentRegistry.register>[0]) => AgentHandle } | null;
}

/**
 * Derive the failure fix-assessment. The monitor can only claim the already
 * -committed changes fix the problem when both hold: it identified the root
 * cause, and there is at least one committed change to have fixed it with.
 */
function assessFix(
  input: MonitorDispatchInput,
  poll: TargetPollResult,
): { identifiedProblem: boolean; canFixWithCommittedChanges: boolean } {
  const identifiedProblem = Boolean(poll.identifiedProblem);
  const hasCommittedChanges = (input.committedChangeRefs?.length ?? 0) > 0;
  return {
    identifiedProblem,
    canFixWithCommittedChanges: identifiedProblem && hasCommittedChanges,
  };
}

/**
 * `MonitorService` (deliverable 1 + 2): dispatches a background monitor
 * subagent per target and reports back on the terminal state only.
 */
export class BackgroundMonitorService implements MonitorService {
  private readonly handlers: MonitorReportHandler[] = [];

  constructor(private readonly deps: MonitorServiceDeps) {}

  /** Registers a handler invoked once per monitor, on its terminal state only. */
  onReport(handler: MonitorReportHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Spawns the background poll and resolves immediately. Never blocks: the
   * poll (`this.watch`) is deliberately not awaited here.
   */
  async dispatch(input: MonitorDispatchInput): Promise<MonitorDispatchResult> {
    const genId = this.deps.genId ?? defaultGenId;
    const nowIso = this.deps.nowIso ?? defaultNowIso;
    const log = this.deps.log ?? defaultLogSink;
    const subagentId = genId();

    log({
      kind: "dispatch",
      targetType: input.targetType,
      targetId: input.targetId,
      subagentId,
      at: nowIso(),
    });

    // Surface the background monitor in the `/hud` HUD for its whole life. The
    // registry default is the process-wide singleton; pass `registry: null` to
    // opt out. Reuse `subagentId` so logs and HUD refer to the same agent.
    const registry = this.deps.registry === undefined ? agentRegistry : this.deps.registry;
    const hud =
      registry?.register({
        kind: "monitor",
        id: subagentId,
        title: `${input.targetType} ${input.targetId}`,
        detail: "watching",
      }) ?? null;

    // Out-of-process-style dispatch: fire the watch loop and return control
    // right away. A caller awaiting `dispatch` never waits on the target's
    // terminal state — only `onReport` handlers see that, and only once.
    void this.watch(input, subagentId, hud);

    return { subagentId, background: true };
  }

  /**
   * The background poll loop. A poll call that resolves is always authoritative
   * (succeeded/failed); a poll call that throws is treated as a transient check
   * failure and retried after the configured interval. Runs exactly once
   * against a deterministic poller that resolves without throwing, so tests
   * never sleep.
   */
  private async watch(
    input: MonitorDispatchInput,
    subagentId: string,
    hud: AgentHandle | null = null,
  ): Promise<void> {
    const pollIntervalSeconds = input.pollIntervalSeconds ?? getPollIntervalSeconds();
    const controller = new AbortController();
    const log = this.deps.log ?? defaultLogSink;
    const nowIso = this.deps.nowIso ?? defaultNowIso;

    let result: TargetPollResult | undefined;
    while (result === undefined) {
      try {
        result = await this.deps.poll(input, controller.signal);
      } catch {
        // Transient poll failure (network blip, rate limit, etc.) — retry
        // after the configured interval rather than giving up on the monitor.
        await sleep(pollIntervalSeconds * 1000);
      }
    }

    const { identifiedProblem, canFixWithCommittedChanges } =
      result.status === "failed"
        ? assessFix(input, result)
        : { identifiedProblem: false, canFixWithCommittedChanges: false };

    const report: MonitorReport = {
      targetId: input.targetId,
      status: result.status,
      ...(result.status === "failed" ? { identifiedProblem, canFixWithCommittedChanges } : {}),
      ...(result.note !== undefined ? { note: result.note } : {}),
    };

    log({
      kind: "report",
      targetType: input.targetType,
      targetId: input.targetId,
      status: result.status,
      identifiedProblem,
      canFixWithCommittedChanges,
      note: result.note ?? "",
      subagentId,
      at: nowIso(),
    });

    // The monitor did its job the moment the target reached a terminal state.
    // Reflect the target's outcome in the HUD detail, then retire the entry.
    hud?.update({ detail: result.status });
    hud?.done();

    for (const handler of this.handlers) handler(report);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
