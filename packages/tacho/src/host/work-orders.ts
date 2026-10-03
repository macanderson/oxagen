/**
 * The work orders waiting on this agent (P1-04, ADR-251).
 *
 * The control plane sends a work order to the agent's host as a `work_order`
 * command. The daemon keeps each one here, one file per order, until the
 * person at the machine runs `oxagen work start <wo>`. That command claims
 * the order and removes its file once the agent's harness has started. A
 * start that fails before then leaves the file. Nothing here starts a run.
 *
 * Each file is `<agent dir>/work-orders/<wo>.json`, written atomically at
 * mode 0600. A file that does not read as an order is skipped, because the
 * directory is on the person's machine and one bad file must not hide the
 * others.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { WORK_ITEM_ID_PATTERN, WORK_ORDER_ID_PATTERN } from "../wire";
import { readJsonFileIfExists, writeSensitiveFileAtomic } from "./fs";
import type { TachoPaths } from "./paths";

/** One work order waiting on this agent. */
export const pendingWorkOrderSchema = z
  .object({
    /** The `work_order` command that brought it. */
    command_id: z.string().min(1),
    work_order: z.string().regex(WORK_ORDER_ID_PATTERN),
    key: z.string().min(1),
    item: z.string().regex(WORK_ITEM_ID_PATTERN),
    /** When the daemon received the command, ISO 8601. */
    received_at: z.string(),
  })
  .passthrough();

export type PendingWorkOrder = z.output<typeof pendingWorkOrderSchema>;

/** The file one order is kept in. The id is checked, so it names no other path. */
function orderFile(paths: Pick<TachoPaths, "workOrders">, id: string): string {
  if (!WORK_ORDER_ID_PATTERN.test(id))
    throw new Error(`${JSON.stringify(id)} is not a work order id`);
  return join(paths.workOrders, `${id}.json`);
}

/** The order kept under `id`, or undefined when there is none or it does not read. */
export function readWorkOrder(
  paths: Pick<TachoPaths, "workOrders">,
  id: string,
): PendingWorkOrder | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileIfExists(orderFile(paths, id));
  } catch {
    return undefined;
  }
  const parsed = pendingWorkOrderSchema.safeParse(raw);
  return parsed.success && parsed.data.work_order === id
    ? parsed.data
    : undefined;
}

/**
 * Keep an order. The drain delivers a command at least once, so the same
 * command arriving again leaves the file as it is, and its first
 * `received_at` stands. Returns false when that happened.
 */
export function keepWorkOrder(
  paths: Pick<TachoPaths, "workOrders">,
  order: PendingWorkOrder,
): boolean {
  const kept = readWorkOrder(paths, order.work_order);
  if (kept !== undefined && kept.command_id === order.command_id) return false;
  writeSensitiveFileAtomic(
    orderFile(paths, order.work_order),
    `${JSON.stringify(order)}\n`,
  );
  return true;
}

/** Every order waiting on this agent, oldest first. */
export function listWorkOrders(
  paths: Pick<TachoPaths, "workOrders">,
): PendingWorkOrder[] {
  let names: string[];
  try {
    names = readdirSync(paths.workOrders);
  } catch {
    return [];
  }
  const orders: PendingWorkOrder[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const order = readWorkOrder(paths, name.slice(0, -".json".length));
    if (order !== undefined) orders.push(order);
  }
  return orders.sort(
    (a, b) =>
      a.received_at.localeCompare(b.received_at) ||
      a.work_order.localeCompare(b.work_order),
  );
}

/** Remove the order kept under `id`. Nothing happens when there is none. */
export function removeWorkOrder(
  paths: Pick<TachoPaths, "workOrders">,
  id: string,
): void {
  rmSync(orderFile(paths, id), { force: true });
}

/**
 * A harness `oxagen work start` started for an order and is still waiting
 * on. The file sits beside the order's own, as `<wo>.running`, so
 * `listWorkOrders` never reads it as an order.
 *
 * Oxagen links one run to a send and stops any other run that names it, but
 * a second harness on the same checkout would still do the work twice before
 * that stop lands. So `start` refuses while the process that wrote this file
 * is alive. A file left by a process that died (a crash, a killed terminal)
 * does not block: the person may start again, and the server refuses the
 * claim if a run already linked.
 *
 * The file also names the order's work item, from the claim, so
 * `oxagen work claim` run inside the harness can name it too. A file an
 * older `start` wrote has no item.
 */
export const runningWorkOrderSchema = z
  .object({
    work_order: z.string().regex(WORK_ORDER_ID_PATTERN),
    /** The `oxagen work start` process that waits on the harness. */
    pid: z.number().int().positive(),
    /** When the harness started, ISO 8601. */
    started_at: z.string(),
    /** The work item the order is for (`wi_…`). */
    item: z.string().regex(WORK_ITEM_ID_PATTERN).optional(),
  })
  .passthrough();

export type RunningWorkOrder = z.output<typeof runningWorkOrderSchema>;

function runningFile(paths: Pick<TachoPaths, "workOrders">, id: string): string {
  if (!WORK_ORDER_ID_PATTERN.test(id))
    throw new Error(`${JSON.stringify(id)} is not a work order id`);
  return join(paths.workOrders, `${id}.running`);
}

/** Whether a process is alive. A process this user may not signal is alive. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Record that a harness for `id` started, waited on by process `pid`, with
 * the order's work item. An item that is not a work item id is left out, so
 * the file still reads and still guards a second start.
 */
export function markWorkOrderRunning(
  paths: Pick<TachoPaths, "workOrders">,
  id: string,
  pid: number,
  startedAt: string,
  item?: string,
): void {
  const record: RunningWorkOrder = {
    work_order: id,
    pid,
    started_at: startedAt,
    ...(item !== undefined && WORK_ITEM_ID_PATTERN.test(item) ? { item } : {}),
  };
  writeSensitiveFileAtomic(runningFile(paths, id), `${JSON.stringify(record)}\n`);
}

/**
 * The running mark for `id`, whether or not its process is alive, or
 * undefined when there is no file or it does not read.
 */
export function readRunningWorkOrder(
  paths: Pick<TachoPaths, "workOrders">,
  id: string,
): RunningWorkOrder | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileIfExists(runningFile(paths, id));
  } catch {
    return undefined;
  }
  const parsed = runningWorkOrderSchema.safeParse(raw);
  return parsed.success && parsed.data.work_order === id
    ? parsed.data
    : undefined;
}

/**
 * The harness still running for `id`, or undefined when none is: no file, a
 * file that does not read, or a process that is gone.
 */
export function runningWorkOrder(
  paths: Pick<TachoPaths, "workOrders">,
  id: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): RunningWorkOrder | undefined {
  const mark = readRunningWorkOrder(paths, id);
  return mark !== undefined && isAlive(mark.pid) ? mark : undefined;
}

/** Clear the running mark for `id`. Nothing happens when there is none. */
export function clearWorkOrderRunning(
  paths: Pick<TachoPaths, "workOrders">,
  id: string,
): void {
  rmSync(runningFile(paths, id), { force: true });
}
