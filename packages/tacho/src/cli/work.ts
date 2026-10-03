/**
 * `oxagen work list`, `oxagen work start <wo>`, and `oxagen work claim
 * <criterion>` (P1-04, ADR-251).
 *
 * A person sends an approved brief to an agent, and the control plane sends
 * the agent's host a `work_order` command. The daemon keeps it in the
 * agent's `work-orders` directory (`host/work-orders.ts`). `list` and `start`
 * are how the person at the machine sees and starts it. `claim` is how the
 * agent, inside the run, says it met one criterion of the brief.
 *
 * `start` claims the order before anything runs. The claim is the handshake:
 * it binds the order to this host and answers with the run's first prompt.
 * Every refusal means do not start: the order ended, it went to another
 * host, or a run already started for it. `start` prints the server's
 * message, starts nothing, exits non-zero, and never claims again on its
 * own. When the claim holds, the agent's harness starts in the current
 * directory with that prompt and with `OXAGEN_WORK_ORDER_ID` in its
 * environment. The hook process inherits the variable, and the daemon names
 * the order on the session's `agent_start`, which is how ingest links the
 * run to the order.
 *
 * The order keeps waiting in `oxagen work list` until the harness has
 * started. Any failure before that leaves it there. While the harness runs,
 * a second `start` for the same order on this machine refuses and starts
 * nothing.
 *
 * A harness this host does not wrap, or one whose command is not installed,
 * cannot start the order. `start` refuses it on the server with the reason,
 * so the send ends and the work item can be sent again.
 *
 * `claim` runs inside the harness `start` started. It reads the order from
 * `OXAGEN_WORK_ORDER_ID`, the work item from the running mark `start`
 * wrote, and the head commit from the checkout, and sends the claim with the
 * host's key. Oxagen files it as the run linked to the send. A claim is the
 * agent's word: a person still checks every criterion and decides.
 */
import { spawnSync } from "node:child_process";
import { agentIsLive, listAgents, type Agent } from "../host/agents";
import {
  type ControlClient,
  ControlError,
  controlErrorMessage,
  controlErrorReason,
  ControlUnreachable,
  createControlClient,
  workOrderEndpointsFor,
} from "../host/control-client";
import type { HostFile } from "../host/host-file";
import { homeOf } from "../host/paths";
import {
  clearWorkOrderRunning,
  listWorkOrders,
  markWorkOrderRunning,
  type PendingWorkOrder,
  readRunningWorkOrder,
  readWorkOrder,
  removeWorkOrder,
  runningWorkOrder,
} from "../host/work-orders";
import {
  HARNESS_BINARY,
  isWrappedHarness,
  TACHO_HARNESS_LABELS,
  WORK_CRITERION_CLAIM_TEXT_MAX,
  WORK_CRITERION_ID_PATTERN,
  WORK_HEAD_SHA_PATTERN,
  type WorkCriterionClaimResponse,
  WORK_ORDER_ENV,
  WORK_ORDER_ID_PATTERN,
  type WorkOrderClaimResponse,
  workOrderIdOf,
  type WrappedHarness,
} from "../wire";
import {
  type AgentExit,
  type AgentRunDeps,
  exitCodeOf,
  spawnAgent,
} from "./agent-run";
import type { CliDeps } from "./deps";

/** The calls `start` and `claim` make to the control plane. */
export type WorkOrderClient = Pick<
  ControlClient,
  "claimWorkOrder" | "rejectWorkOrder" | "claimWorkCriterion"
>;

export interface WorkCommandDeps
  extends Pick<CliDeps, "paths" | "env" | "fetch" | "out" | "err"> {
  /** The directory the harness starts in. */
  cwd: string;
  /** Start the harness and wait for it; `spawnAgent` unless a test passes one. */
  spawnAgent?: AgentRunDeps["spawnAgent"];
  /** The control plane client for one enrollment; a test passes a fake. */
  workOrderClient?: (host: HostFile) => WorkOrderClient;
  /** Whether a process is alive; `processIsAlive` unless a test passes one. */
  processIsAlive?: (pid: number) => boolean;
  /** The head commit of the checkout at `cwd`; `gitHeadIn` unless a test passes one. */
  gitHead?: (cwd: string) => string | undefined;
}

/** The live agents on this machine, each with its enrollment. */
function liveAgents(deps: Pick<CliDeps, "paths">) {
  return listAgents(homeOf(deps.paths)).filter(agentIsLive);
}

const NOT_ENROLLED =
  "This machine is not enrolled, so no work order can reach it. Run `oxagen agent enroll` first.";

/** `oxagen work list`. Returns the exit code. */
export function workList(deps: WorkCommandDeps): number {
  const agents = liveAgents(deps);
  if (agents.length === 0) {
    deps.err(NOT_ENROLLED);
    return 1;
  }
  const rows: Array<{ order: PendingWorkOrder; agent: string }> = [];
  for (const agent of agents)
    for (const order of listWorkOrders(agent.paths))
      rows.push({ order, agent: agent.host.agent_key });
  if (rows.length === 0) {
    deps.out("No work orders are waiting on this machine.");
    return 0;
  }
  deps.out(
    rows.length === 1
      ? "1 work order is waiting on this machine:"
      : `${rows.length} work orders are waiting on this machine:`,
  );
  for (const { order, agent } of rows)
    deps.out(
      `  ${order.work_order}  item ${order.item}  received ${order.received_at}  key ${order.key}${agents.length > 1 ? `  agent ${agent}` : ""}`,
    );
  deps.out(
    "Go to the repository, then run `oxagen work start <work order>` to claim one and start the agent.",
  );
  return 0;
}

/**
 * The harness's arguments for a first prompt. Claude Code, Codex, and
 * Cursor's `cursor-agent` take it as their one positional argument and open
 * an interactive session on it. Stella takes it after `run`. The same table
 * starts a transferred session in `arp/transfer.ts`.
 */
function promptArgs(harness: WrappedHarness, prompt: string): string[] {
  return harness === "stella" ? ["run", prompt] : [prompt];
}

/** The agent whose directory keeps `id`, or the only live agent when none does. */
function claimingAgent(
  agents: readonly (Agent & { host: HostFile })[],
  id: string,
): (Agent & { host: HostFile }) | undefined {
  for (const agent of agents)
    if (readWorkOrder(agent.paths, id) !== undefined) return agent;
  // The daemon may not have polled yet. One live agent is the only host
  // here that could hold the order, and a claim from the wrong host is
  // refused without recording anything.
  const [only] = agents;
  return only !== undefined && agents.length === 1 ? only : undefined;
}

function defaultClient(deps: WorkCommandDeps) {
  return (host: HostFile): WorkOrderClient =>
    createControlClient({
      endpoints: { ...host.endpoints, ...workOrderEndpointsFor(host.api_url) },
      apiKey: host.api_key,
      hostEnrollmentId: host.host_enrollment_id,
      fetch: deps.fetch,
      userAgent: `oxagen/${host.wrapper_version}`,
    });
}

/** What went wrong, for the person at the machine. */
function messageOf(error: unknown): string {
  if (error instanceof ControlError) return controlErrorMessage(error);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tell the control plane this host cannot start the order. A failure here
 * is reported and does not change the exit code: the order stays claimed,
 * and a person can withdraw it in the app.
 */
async function refuse(
  client: WorkOrderClient,
  id: string,
  reason: string,
  deps: WorkCommandDeps,
): Promise<void> {
  try {
    await client.rejectWorkOrder(id, reason);
    deps.err(
      `${reason} Oxagen has ended this send, and the work item can be sent again.`,
    );
  } catch (error) {
    deps.err(reason);
    deps.err(
      `Could not tell Oxagen that ${id} cannot start: ${messageOf(error)}`,
    );
  }
}

/** `oxagen work start <wo>`. Returns the exit code. */
export async function workStart(
  id: string,
  deps: WorkCommandDeps,
): Promise<number> {
  if (!WORK_ORDER_ID_PATTERN.test(id)) {
    deps.err(
      `${JSON.stringify(id)} is not a work order id. A work order id starts with wo_. Run \`oxagen work list\` to see the ones waiting.`,
    );
    return 2;
  }
  const agents = liveAgents(deps);
  if (agents.length === 0) {
    deps.err(NOT_ENROLLED);
    return 1;
  }
  // A harness this machine already started for the order is still running.
  // Oxagen would stop a second run once it linked, but by then two harnesses
  // would be working one checkout, so nothing claims or starts.
  for (const each of agents) {
    const running = runningWorkOrder(each.paths, id, deps.processIsAlive);
    if (running !== undefined) {
      deps.err(
        `A harness for ${id} is already running on this machine (process ${running.pid}), so nothing else started. Wait for it to end, or stop the run from the work item.`,
      );
      return 1;
    }
  }
  const agent = claimingAgent(agents, id);
  if (agent === undefined) {
    deps.err(
      `Work order ${id} is not waiting on this machine. Run \`oxagen work list\` to see the ones that are.`,
    );
    return 1;
  }
  const client = (deps.workOrderClient ?? defaultClient(deps))(agent.host);

  let claim: WorkOrderClaimResponse;
  try {
    claim = await client.claimWorkOrder(id);
  } catch (error) {
    // Every refusal means do not start, and the message says why: the send
    // ended, the order went to another host (403), or a run already started
    // for it. The person decides what to do next, so nothing claims again.
    if (error instanceof ControlError)
      deps.err(
        `Oxagen refused the claim on ${id}, so nothing started. ${controlErrorMessage(error)}`,
      );
    else if (error instanceof ControlUnreachable)
      deps.err(
        `Could not reach Oxagen to claim ${id}, so nothing started. Run this command again once this machine is online. (${error.message})`,
      );
    else
      deps.err(
        `Could not read Oxagen's answer to the claim on ${id}, so nothing started. (${messageOf(error)})`,
      );
    return 1;
  }
  const harness = claim.work_order.harness;
  if (!isWrappedHarness(harness) || !agent.host.harnesses.includes(harness)) {
    const labels: Readonly<Record<string, string | undefined>> =
      TACHO_HARNESS_LABELS;
    const name = labels[harness] ?? harness;
    await refuse(
      client,
      id,
      `This machine does not wrap ${name}, so it cannot start this work order.`,
      deps,
    );
    return 1;
  }

  const binary = HARNESS_BINARY[harness];
  const label = TACHO_HARNESS_LABELS[harness];
  if (claim.repeat)
    deps.err(
      `This machine had already claimed ${id}. Only the first run that starts for it is linked to it.`,
    );
  deps.err(
    `Claimed ${id} for ${claim.work_order.item_number} in ${claim.work_order.repository}. Starting ${label} in ${deps.cwd}.`,
  );
  // The order stops waiting once the harness has started, and not before:
  // a start that fails leaves it in `oxagen work list`.
  const removeOrder = () => {
    try {
      removeWorkOrder(agent.paths, id);
    } catch {
      // The harness runs either way. An entry left behind stays listed, and
      // the server refuses a second start once the run links.
    }
  };
  // While the harness runs, this process marks the order running, so a
  // second `start` on this machine refuses instead of starting another.
  let marked = false;
  const started = () => {
    removeOrder();
    if (marked) return;
    marked = true;
    try {
      markWorkOrderRunning(
        agent.paths,
        id,
        process.pid,
        new Date().toISOString(),
        claim.work_order.item_id,
      );
    } catch {
      // The mark only guards this machine. The server still links one run.
    }
  };
  let exit: AgentExit;
  try {
    exit = await (deps.spawnAgent ?? spawnAgent)(
      binary,
      promptArgs(harness, claim.prompt),
      {
        env: { ...deps.env, [WORK_ORDER_ENV]: id },
        cwd: deps.cwd,
        onSpawn: started,
      },
    );
  } finally {
    if (marked) {
      try {
        clearWorkOrderRunning(agent.paths, id);
      } catch {
        // A mark left behind names this process, which is about to exit, so
        // it blocks nothing.
      }
    }
  }
  if (exit.error === undefined) {
    // A process that exited without an error started, whether or not the
    // spawn reported it first.
    removeOrder();
    return exitCodeOf(exit);
  }
  if ((exit.error as NodeJS.ErrnoException).code === "ENOENT") {
    await refuse(
      client,
      id,
      `The ${binary} command is not installed on this machine.`,
      deps,
    );
    return 1;
  }
  // Something else stopped the start. The claim stands and repeats until a
  // run links, so the person can try again once the cause is fixed.
  deps.err(
    `Could not start ${binary}: ${exit.error.message}. The claim on ${id} stands. Fix the cause, then run \`oxagen work start ${id}\` again.`,
  );
  return exitCodeOf(exit);
}

/**
 * The commit checked out at `cwd`, or undefined when `cwd` is not in a Git
 * checkout with a commit, or the commit is not a 40-character SHA-1.
 */
export function gitHeadIn(cwd: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0) return undefined;
  const head = result.stdout.trim();
  return WORK_HEAD_SHA_PATTERN.test(head) ? head : undefined;
}

/** What `oxagen work claim` says about one refusal from Oxagen. */
function claimRefusalMessage(
  error: ControlError,
  criterionId: string,
  head: string,
): string {
  const said = controlErrorMessage(error);
  const short = head.slice(0, 7);
  if (controlErrorReason(error) === "stale_head")
    return `Oxagen refused the claim on ${criterionId} at commit ${short}, so nothing was recorded. ${said} Push commit ${short} to the pull request first, then claim again.`;
  if (error.status === 400)
    return `Oxagen refused the claim on ${criterionId}, so nothing was recorded. ${said} Name a criterion from the brief in your first prompt, such as c1.`;
  return `Oxagen refused the claim on ${criterionId}, so nothing was recorded. ${said}`;
}

/** What `oxagen work claim` says about the answer Oxagen gave. */
function claimAnswerMessage(
  answer: WorkCriterionClaimResponse,
  criterionId: string,
  workOrderId: string,
  head: string,
): string {
  const short = head.slice(0, 7);
  return answer.repeat
    ? `Oxagen already had this claim on ${criterionId} at commit ${short}, so nothing new was recorded. The first text stands.`
    : `Claimed ${criterionId} at commit ${short} for ${workOrderId}. A person still checks each criterion and decides.`;
}

/**
 * `oxagen work claim <criterion> --text <how>`: the agent working a send
 * says it met one criterion of the brief on the head commit it pushed.
 * Returns the exit code: 0 when Oxagen recorded the claim or already had it,
 * 1 when this is not a work order's run or Oxagen refused, and 2 when the
 * criterion id or the text is not one Oxagen takes.
 */
export async function workClaim(
  criterionId: string,
  options: { text: string },
  deps: WorkCommandDeps,
): Promise<number> {
  if (!WORK_CRITERION_ID_PATTERN.test(criterionId)) {
    deps.err(
      `${JSON.stringify(criterionId)} is not a criterion id. A criterion id is c and a number, such as c1, as the brief in your first prompt lists them.`,
    );
    return 2;
  }
  const text = options.text.trim();
  if (text.length === 0 || text.length > WORK_CRITERION_CLAIM_TEXT_MAX) {
    deps.err(
      `Say how you met ${criterionId} with --text, in 1 to ${WORK_CRITERION_CLAIM_TEXT_MAX} characters.`,
    );
    return 2;
  }
  const workOrderId = workOrderIdOf(deps.env[WORK_ORDER_ENV]);
  if (workOrderId === undefined) {
    deps.err(
      `${WORK_ORDER_ENV} is not set, so this shell is not a work order's run. Run \`oxagen work claim\` from inside the run that \`oxagen work start\` started.`,
    );
    return 1;
  }
  const agents = liveAgents(deps);
  if (agents.length === 0) {
    deps.err(NOT_ENROLLED);
    return 1;
  }
  // The agent whose directory holds the running mark is the host that
  // claimed the order. The mark also names the work item.
  let found:
    | { agent: (typeof agents)[number]; item: string | undefined }
    | undefined;
  for (const agent of agents) {
    const mark = readRunningWorkOrder(agent.paths, workOrderId);
    if (mark !== undefined) {
      found = { agent, item: mark.item };
      break;
    }
  }
  if (found === undefined) {
    deps.err(
      `No run of ${workOrderId} is running on this machine. Run \`oxagen work claim\` from inside the work order's run, which \`oxagen work start ${workOrderId}\` starts.`,
    );
    return 1;
  }
  const { agent, item } = found;
  if (item === undefined) {
    deps.err(
      `The run of ${workOrderId} on this machine does not record its work item, because an older oxagen started it. Claims work in the next run that \`oxagen work start\` starts.`,
    );
    return 1;
  }
  const head = (deps.gitHead ?? gitHeadIn)(deps.cwd);
  if (head === undefined) {
    deps.err(
      `Could not read the head commit in ${deps.cwd}. Run \`oxagen work claim\` in the work order's checkout, after you commit and push.`,
    );
    return 1;
  }
  const client = (deps.workOrderClient ?? defaultClient(deps))(agent.host);
  let answer: WorkCriterionClaimResponse;
  try {
    answer = await client.claimWorkCriterion({
      item_id: item,
      work_order_id: workOrderId,
      criterion_id: criterionId,
      head_sha: head,
      text,
    });
  } catch (error) {
    if (error instanceof ControlError)
      deps.err(claimRefusalMessage(error, criterionId, head));
    else if (error instanceof ControlUnreachable)
      deps.err(
        `Could not reach Oxagen to claim ${criterionId}, so nothing was recorded. Run this command again once this machine is online. (${error.message})`,
      );
    else
      deps.err(
        `Could not read Oxagen's answer to the claim on ${criterionId}. Run this command again. The same claim on the same commit records nothing new. (${messageOf(error)})`,
      );
    return 1;
  }
  deps.out(claimAnswerMessage(answer, criterionId, workOrderId, head));
  return 0;
}
