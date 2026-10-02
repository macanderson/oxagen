// work-order-send-back-ports.ts: the seam between the hourly send-back job
// (functions/cost.work-order-send-back.ts) and the stores it writes through
// (R3, #5108).
//
// The job resolves a work item to its collector through the work intake
// stores, and records each note it posts in work.send_backs. Both live in
// `@oxagen/handlers` (lib/work-intake/send-back.ts), which depends on this
// package, so this package cannot import them. The handlers' register module
// installs the ports when the API process boots, before the Inngest route can
// invoke a function. Every value the ports touch stays inside one durable
// step, so nothing here crosses a step as JSON.
import type { SendBackPorts } from "@oxagen/ingestion/collectors";

/** The org and workspace one pass runs in. */
export interface WorkOrderSendBackScope {
  orgId: string;
  workspaceId: string;
}

/** The ports for one workspace. Call each port inside runInTenantScope for that workspace. */
export type WorkOrderSendBackPortsFor = (
  scope: WorkOrderSendBackScope,
) => Promise<SendBackPorts>;

let portsFor: WorkOrderSendBackPortsFor | null = null;

/** Install the ports. `@oxagen/handlers/register` calls this at boot. */
export function setWorkOrderSendBackPorts(
  next: WorkOrderSendBackPortsFor | null,
): void {
  portsFor = next;
}

/** The installed ports. It throws in a process that booted without handlers. */
export function workOrderSendBackPorts(): WorkOrderSendBackPortsFor {
  if (!portsFor)
    throw new Error(
      "[cost.work-order-send-back] no send-back ports are installed. Import @oxagen/handlers/register before serving Inngest functions.",
    );
  return portsFor;
}
