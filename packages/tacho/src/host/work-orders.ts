/**
 * The work orders waiting on this agent (P1-04, ADR-250).
 *
 * The control plane sends a work order to the agent's host as a `work_order`
 * command. The daemon keeps each one here, one file per order, until the
 * person at the machine runs `oxagen work start <wo>`. That command claims
 * the order and removes its file. Nothing here starts a run.
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
