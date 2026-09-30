// collectors/cloudevent.ts: the CloudEvents 1.0 envelope a work.inbound_events
// row stores, and the request it rebuilds for doorbell.
//
// The envelope carries the delivery as the provider sent it: a compact JSON
// body as `data`, anything else as `data_base64`. Two extension attributes keep what
// doorbell needs later: `oxagenheaders`, the request headers as a JSON string
// with the credential headers removed, and `oxagensha256`, the body's digest,
// which is also the raw body's object storage key.
import { createHash } from "node:crypto";
import type { InboundRequest } from "./types";

/** The CloudEvents type of a delivery the doorbell stored. */
export const COLLECTOR_DELIVERY_TYPE = "sh.oxagen.work.collector.delivery";

/** The CloudEvents type of a reconcile's result row. */
export const COLLECTOR_RECONCILE_TYPE = "sh.oxagen.work.collector.reconcile";

/** The CloudEvents type of a nightly count's result row. */
export const COLLECTOR_COUNT_TYPE = "sh.oxagen.work.collector.count";

/** Headers never stored: they carry a credential, not a delivery. */
const DROPPED_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);

export interface CollectorCloudEvent {
  specversion: "1.0";
  /** The provider's delivery id, or the reconcile or count key. */
  id: string;
  /** `/work/collectors/<collector id>`. */
  source: string;
  type: string;
  /** RFC 3339. */
  time: string;
  datacontenttype?: string;
  data?: unknown;
  data_base64?: string;
  /** The request headers as a JSON object string. Deliveries only. */
  oxagenheaders?: string;
  /** `sha256:<hex>` over the raw body. Deliveries only. */
  oxagensha256?: string;
}

/** `sha256:<hex>` over the raw body. */
export function bodyDigest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** The CloudEvents source for one collector. */
export function collectorSource(collectorId: string): string {
  return `/work/collectors/${collectorId}`;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const media = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json" || media.endsWith("+json");
}

/** Wrap a verified delivery. The body is data; nothing here reads it as an instruction. */
export function deliveryCloudEvent(args: {
  collectorId: string;
  deliveryId: string;
  request: InboundRequest;
}): CollectorCloudEvent {
  const { collectorId, deliveryId, request } = args;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (!DROPPED_HEADERS.has(key)) headers[key] = value;
  }
  const event: CollectorCloudEvent = {
    specversion: "1.0",
    id: deliveryId,
    source: collectorSource(collectorId),
    type: COLLECTOR_DELIVERY_TYPE,
    time: request.receivedAt,
    oxagenheaders: JSON.stringify(headers),
    oxagensha256: bodyDigest(request.body),
  };
  const contentType = headers["content-type"];
  const text = Buffer.from(request.body).toString("utf8");
  if (isJsonContentType(contentType) || contentType === undefined) {
    try {
      const parsed = JSON.parse(text) as unknown;
      // Keep the value as data only when it writes back to the same bytes.
      // Spacing, key escapes, or an integer above 2^53 would change on the
      // way back, so such a body is kept byte for byte below.
      if (JSON.stringify(parsed) === text) {
        event.data = parsed;
        event.datacontenttype = "application/json";
        return event;
      }
    } catch {
      // Not JSON after all. It is kept byte for byte below.
    }
  }
  event.datacontenttype = contentType ?? "application/octet-stream";
  event.data_base64 = Buffer.from(request.body).toString("base64");
  return event;
}

/** A result row's envelope: a reconcile or a nightly count. */
export function resultCloudEvent(args: {
  collectorId: string;
  key: string;
  type: typeof COLLECTOR_RECONCILE_TYPE | typeof COLLECTOR_COUNT_TYPE;
  time: string;
  data: Record<string, unknown>;
}): CollectorCloudEvent {
  return {
    specversion: "1.0",
    id: args.key,
    source: collectorSource(args.collectorId),
    type: args.type,
    time: args.time,
    datacontenttype: "application/json",
    data: args.data,
  };
}

/**
 * The request doorbell reads, rebuilt from a stored delivery. The body comes
 * back byte for byte: a JSON body is kept as data only when it writes back to
 * the same text. The signature was checked once, when the delivery arrived.
 */
export function requestFromCloudEvent(event: CollectorCloudEvent): InboundRequest {
  let headers: Record<string, string> = {};
  if (event.oxagenheaders !== undefined) {
    const parsed = JSON.parse(event.oxagenheaders) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      headers = parsed as Record<string, string>;
  }
  const body =
    event.data_base64 !== undefined
      ? new Uint8Array(Buffer.from(event.data_base64, "base64"))
      : new Uint8Array(
          Buffer.from(event.data === undefined ? "" : JSON.stringify(event.data), "utf8"),
        );
  return { headers, body, receivedAt: event.time };
}
