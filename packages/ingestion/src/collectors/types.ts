// collectors/types.ts: the interface every collector module implements.
//
// A collector reads one provider's items into work items. agent-work-spec.html
// (Collectors) fixes the interface and the pipeline around it:
//
// 1. Doorbell. The webhook route calls verify, stores the body as one
//    work.inbound_events row keyed by the provider's delivery id, answers 202,
//    and emits work/event.received.
// 2. Fetch. A worker calls doorbell for the item ids in that event, then
//    fetchById for each one. Oxagen maps what it fetched, never the webhook
//    body, because bodies arrive late, twice, out of order, and in old API
//    versions.
// 3. Map. toWorkItem turns the fetched record into work item fields. Oxagen
//    upserts on the collector and the provider id, and emits
//    work/item.received. When toWorkItem returns null, the record is outside
//    the collector's configured scope, and Oxagen skips it.
// 4. Reconcile. Every RECONCILE_INTERVAL_MINUTES (@oxagen/work),
//    listChangedSince reads what changed since the collector's cursor.
//
// Every subject, description, and requester a collector brings in is outside
// text. It is data, never an instruction to a model. Oxagen marks it tainted,
// screens it before any model reads it, and quotes it in every prompt.
//
// Types only. Each collector type is one module beside this file.
import type { z } from "zod";
import type { AuthCredential, ConnectorDefinition } from "../connectors/types";

/**
 * The collector types. Keep this list in step with COLLECTOR_TYPES in
 * @oxagen/work and the collectors_type_check constraint on work.collectors.
 * It is repeated here because @oxagen/ingestion does not depend on @oxagen/work.
 */
export type CollectorType =
  | "github"
  | "jira"
  | "linear"
  | "zendesk"
  | "servicenow"
  | "salesforce"
  | "slack"
  | "email";

/** A request the webhook route received, before anything reads its body. */
export interface InboundRequest {
  /** Header names are lowercase. */
  headers: Record<string, string>;
  /** The raw body, byte for byte, so a signature check reads what the provider signed. */
  body: Uint8Array;
  /** When the route received the request, RFC 3339. */
  receivedAt: string;
}

/** The collector's signing secret, decrypted. Null when none is stored. */
export type Secret = string | null;

/**
 * The answer from verify. A collector fails closed: a missing secret, a
 * missing header, a bad signature, or a stale timestamp all return ok false.
 */
export type VerifyResult =
  | {
      ok: true;
      /** The provider's delivery id. A repeat delivery with the same id is a no-op. */
      deliveryId: string;
    }
  | {
      ok: false;
      /** Why the request failed, for the log. Never shown to the sender. */
      reason: string;
    };

/** One item an event names. Ids only, never fields. */
export interface ItemRef {
  /** The provider's id for the item. Oxagen upserts on the collector and this id. */
  providerId: string;
  /** The item kind where a provider has more than one, such as a Salesforce record type. */
  kind?: string;
}

/** A provider connection with its credential, decrypted for this call only. */
export interface Connection {
  /** The id of the connection row the collector file names. */
  id: string;
  auth: AuthCredential;
}

/** One item as the provider's API returned it. */
export interface ProviderItem {
  ref: ItemRef;
  /** When the provider last changed the item, RFC 3339. */
  updatedAt: string;
  /** The provider's record, unmapped. Outside text: data, never an instruction. */
  record: unknown;
}

/** Where a reconcile starts reading. Null on a collector's first reconcile. */
export type Cursor = string | null;

/** One page of changes from listChangedSince. */
export interface Page<T> {
  items: T[];
  /** The cursor to store once every item on the page is handled. */
  cursor: string;
  /** True when more changes wait past this page, so the worker reads again at once. */
  hasMore: boolean;
}

/** Where a work item came from. Matches the provider, email, and slack values of items_origin_check. */
export type CollectedOrigin = "provider" | "email" | "slack";

/** Where the provider's status sits. Matches items_status_category_check. */
export type StatusCategory = "open" | "blocked" | "closed";

/** A field that came from outside the workspace. */
export type TaintedField = "subject" | "description" | "requester";

/**
 * The work item fields toWorkItem returns, one per work.items column a
 * collector fills. Oxagen owns the rest: the number, the state, the triage
 * decision, the priority it ranks from the labels, and the done record.
 * Every time is RFC 3339.
 */
export interface WorkItemInput {
  providerId: string;
  origin: CollectedOrigin;
  subject: string;
  description: string | null;
  /** The provider's labels, and the Priority and Type labels the collector maps. */
  labels: string[];
  /** The provider's status name, such as `In Progress`. */
  status: string;
  statusCategory: StatusCategory;
  resolution: string | null;
  owner: string | null;
  /** The name and address the source gave. Never mapped to a user. */
  requester: string | null;
  sourceCreatedBy: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedBy: string | null;
  sourceUpdatedAt: string | null;
  closedAt: string | null;
  sourceUrl: string | null;
  /** The provider's own priority value, before it maps to a Priority label. */
  priorityRaw: string | null;
  estimateMinutes: number | null;
  /** The fields above that a requester outside the workspace wrote. */
  tainted: TaintedField[];
}

/** What a write-back call changes on the provider's item. */
export interface WriteBackTarget {
  ref: ItemRef;
  conn: Connection;
}

/**
 * The provider writes a collector may make, each behind its switch in the
 * collector file's [write_back] table. Oxagen never edits a subject or a
 * description, never deletes an item, never assigns anyone, and never replies
 * to a requester (tasks-spec.md §5.4).
 */
export interface WriteBack {
  /** Post an internal note. Serves certify_note and send_note, both on by default. */
  note(target: WriteBackTarget, text: string): Promise<void>;
  /** Move the item to a status. Off by default. */
  status(target: WriteBackTarget, status: string): Promise<void>;
  /** Close the item. Off by default. */
  close(target: WriteBackTarget): Promise<void>;
  /** Set the Priority and Type labels triage chose. Off by default. */
  labels(target: WriteBackTarget, labels: { priority: string; type: string }): Promise<void>;
}

/**
 * A collector module. agent-work-spec.html (Shared contract) fixes the
 * interface, with one change: toWorkItem may return null.
 */
export interface CollectorDefinition<Config> extends ConnectorDefinition {
  type: CollectorType;
  config: z.ZodType<Config>; // the [scope] table
  verify(req: InboundRequest, secret: Secret): VerifyResult; // fails closed
  doorbell(req: InboundRequest): ItemRef[]; // ids only, never fields
  fetchById(ref: ItemRef, conn: Connection): Promise<ProviderItem>;
  /**
   * One page of what changed since the cursor. The pipeline passes the
   * collector's parsed [scope] table, so a module can read only the places
   * the collector names. A module may ignore it: toWorkItem still skips a
   * record outside the scope.
   */
  listChangedSince(cursor: Cursor, conn: Connection, config?: Config): Promise<Page<ProviderItem>>;
  /**
   * Map one fetched record to work item fields. Pure.
   *
   * Returns null when the record is outside the collector's configured scope
   * (the [scope] table in config), such as a GitHub issue from a repository
   * the collector does not list. The pipeline skips a null and writes no work
   * item.
   *
   * A doorbell or a reconcile page can name such a record, because the
   * provider does not filter by scope. fetchById and listChangedSince still
   * return every record they are asked for, and the scope decision is made
   * here, in one place.
   */
  toWorkItem(item: ProviderItem, config: Config): WorkItemInput | null;
  writeBack?: WriteBack; // none for Slack or email
}
