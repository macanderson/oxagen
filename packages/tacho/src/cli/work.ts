/**
 * `oxagen work list` and `oxagen work start <wo>` (P1-04, ADR-251).
 *
 * A person sends an approved brief to an agent, and the control plane sends
 * the agent's host a `work_order` command. The daemon keeps it in the
 * agent's `work-orders` directory (`host/work-orders.ts`). These two commands
 * are how the person at the machine sees and starts it.
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
 * started. Any failure before that leaves it there.
 *
 * A harness this host does not wrap, or one whose command is not installed,
 * cannot start the order. `start` refuses it on the server with the reason,
 * so the send ends and the work item can be sent again.
 */
import { agentIsLive, listAgents, type Agent } from "../host/agents";
import {
  type ControlClient,
  ControlError,
  controlErrorMessage,
  ControlUnreachable,
  createControlClient,
  workOrderEndpointsFor,
} from "../host/control-client";
import type { HostFile } from "../host/host-file";
import { homeOf } from "../host/paths";
import {
  listWorkOrders,
  type PendingWorkOrder,
  readWorkOrder,
  removeWorkOrder,
} from "../host/work-orders";
import {
  HARNESS_BINARY,
  isWrappedHarness,
  TACHO_HARNESS_LABELS,
  WORK_ORDER_ENV,
  WORK_ORDER_ID_PATTERN,
  type WorkOrderClaimResponse,
  type WrappedHarness,
} from "../wire";
import { type AgentRunDeps, exitCodeOf, spawnAgent } from "./agent-run";
import type { CliDeps } from "./deps";

/** The two calls `start` makes to the control plane. */
export type WorkOrderClient = Pick<
  ControlClient,
  "claimWorkOrder" | "rejectWorkOrder"
>;

export interface WorkCommandDeps
  extends Pick<CliDeps, "paths" | "env" | "fetch" | "out" | "err"> {
  /** The directory the harness starts in. */
  cwd: string;
  /** Start the harness and wait for it; `spawnAgent` unless a test passes one. */
  spawnAgent?: AgentRunDeps["spawnAgent"];
  /** The control plane client for one enrollment; a test passes a fake. */
  workOrderClient?: (host: HostFile) => WorkOrderClient;
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
  const started = () => {
    try {
      removeWorkOrder(agent.paths, id);
    } catch {
      // The harness runs either way. An entry left behind stays listed, and
      // the server refuses a second start once the run links.
    }
  };
  const exit = await (deps.spawnAgent ?? spawnAgent)(
    binary,
    promptArgs(harness, claim.prompt),
    {
      env: { ...deps.env, [WORK_ORDER_ENV]: id },
      cwd: deps.cwd,
      onSpawn: started,
    },
  );
  if (exit.error === undefined) {
    // A process that exited without an error started, whether or not the
    // spawn reported it first.
    started();
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
