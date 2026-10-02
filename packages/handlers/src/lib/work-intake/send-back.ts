// send-back.ts: the ports the send-back job writes through (R3, #5108).
//
// F34 (#5085) sends a work order back to its work item when its last runs
// each ended with nothing kept. The hourly job in @oxagen/inngest-functions
// (functions/cost.work-order-send-back.ts) finds those work orders and calls
// sendBackWorkOrders (@oxagen/ingestion/collectors) with these two ports:
//
// - record: work.send_backs, one row per note posted, keyed by the work order
//   and the newest run of its streak. sendBackWorkOrders adds a row only when
//   the note was written, so a switch that is off, a paused collector, or a
//   module with no write-back records nothing, and the next pass tries again.
// - resolve: a work item's collector, its connection, and its item at the
//   provider, read through the work intake stores (collector-store.ts,
//   ports.ts). A work item with no collector, such as one a person entered,
//   resolves to null.
//
// Phase 1 keeps provider write-back off (ADR-250). A collector row stores no
// switches: it mirrors a collector/v1 document with every write-back switch
// off, so every switch reads off here and no note reaches a provider yet.
// Turning write-back on is #4775's Phase 2: it gives a collector its switches
// and a module its writeBack, and passes them in through SendBackOptions.
//
// Every port opens its own tenant transaction, so the caller runs inside
// runInTenantScope for the same org and workspace.
import { schema, withTenantDb } from "@oxagen/database";
import {
  type AnyCollectorDefinition,
  type CollectorRecord,
  type CollectorType,
  type Connection,
  getCollector,
  registerCollectorModules,
  resolveWriteBack,
  type SendBackPorts,
  type SendBackRecord,
  type SendBackTarget,
  type WriteBackCollector,
  type WriteBackSwitches,
} from "@oxagen/ingestion/collectors";
import { and, eq } from "drizzle-orm";
import type { WorkScope } from "../work-records/store";
import { postgresCollectorStore } from "./collector-store";
import { collectorConnection } from "./ports";

const sendBacks = schema.workSendBacks;
const items = schema.workItems;

/** The [write_back] table of every Phase 1 collector row: each switch off (ADR-250). */
const PHASE_ONE_WRITE_BACK: Readonly<WriteBackSwitches> = Object.freeze({
  certify_note: false,
  send_note: false,
  status: false,
  close: false,
  labels: false,
});

/** Where a collector's switches and module come from. Production reads the Phase 1 defaults. */
export interface SendBackOptions {
  /** The switches in force for a collector. */
  switches?: (collector: CollectorRecord) => WriteBackSwitches;
  /** The module for a collector type, or undefined when none is registered. */
  definition?: (type: CollectorType) => AnyCollectorDefinition | undefined;
}

/** The switches a Phase 1 collector row mirrors: every one off. */
function phaseOneSwitches(collector: CollectorRecord): WriteBackSwitches {
  return resolveWriteBack(collector.type, PHASE_ONE_WRITE_BACK);
}

function registeredModule(type: CollectorType): AnyCollectorDefinition | undefined {
  registerCollectorModules();
  return getCollector(type);
}

/** True when runWriteBack would call the module for a send note. */
function canSendNote(collector: WriteBackCollector): boolean {
  return collector.switches.send_note && collector.health !== "paused" && collector.definition.writeBack !== undefined;
}

/** The send-back record on work.send_backs for one org and workspace. */
function postgresSendBackRecord(scope: WorkScope): SendBackRecord {
  return {
    async has(key) {
      const [row] = await withTenantDb((tx) =>
        tx
          .select({ id: sendBacks.id })
          .from(sendBacks)
          .where(
            and(
              eq(sendBacks.orgId, scope.orgId),
              eq(sendBacks.workspaceId, scope.workspaceId),
              eq(sendBacks.orderId, key.orderId),
              eq(sendBacks.lastRunId, key.lastRunId),
            ),
          )
          .limit(1),
      );
      return row !== undefined;
    },

    async add(key) {
      // A second add of the same streak changes nothing.
      await withTenantDb((tx) =>
        tx
          .insert(sendBacks)
          .values({ orgId: scope.orgId, workspaceId: scope.workspaceId, orderId: key.orderId, lastRunId: key.lastRunId })
          .onConflictDoNothing({ target: [sendBacks.orderId, sendBacks.lastRunId] }),
      );
    },
  };
}

/**
 * The collector a work item came from and the provider item to write on.
 * Null when the work item names no collector or no provider id, as a work
 * item a person entered does, when its collector row is gone, or when no
 * module is registered for the collector's type.
 *
 * Oxagen mints a credential only when the note can be written: the send_note
 * switch is on, the collector is not paused, and its module has write-back.
 * Otherwise runWriteBack calls no module, so the connection carries no
 * credential. That keeps a broken connection from failing a pass that could
 * write nothing.
 */
async function resolveSendBackTarget(
  scope: WorkScope,
  itemId: string,
  options: SendBackOptions = {},
): Promise<SendBackTarget | null> {
  const [item] = await withTenantDb((tx) =>
    tx
      .select({ collectorId: items.collectorId, providerId: items.providerId })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId)))
      .limit(1),
  );
  if (!item || item.collectorId === null || item.providerId === null) return null;
  const record = await postgresCollectorStore(scope).getCollector(item.collectorId);
  if (record === null) return null;
  const definition = (options.definition ?? registeredModule)(record.type);
  if (definition === undefined) return null;
  const collector: WriteBackCollector = {
    definition,
    switches: (options.switches ?? phaseOneSwitches)(record),
    health: record.health,
  };
  const conn: Connection = canSendNote(collector)
    ? await collectorConnection(scope, record)
    : { id: record.connectionId ?? "", auth: { scheme: "public" } };
  // The row keeps no item kind. A GitHub collector has one kind, its issues,
  // and its module reads the provider id alone.
  return { collector, target: { ref: { providerId: item.providerId }, conn } };
}

/** The ports sendBackWorkOrders takes for one org and workspace. */
export function sendBackPorts(scope: WorkScope, options: SendBackOptions = {}): SendBackPorts {
  return {
    resolve: (itemId) => resolveSendBackTarget(scope, itemId, options),
    record: postgresSendBackRecord(scope),
  };
}
