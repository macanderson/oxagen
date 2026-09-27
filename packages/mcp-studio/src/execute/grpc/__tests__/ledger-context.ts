// ledger-context.ts: request templates and a SendContext for the ledger
// fixture, for the grpc Sender's tests.
import type { ManifestAuth, ManifestServer, ManifestShaping } from "../../../contract/manifest";
import type { GrpcRequest } from "../../../model/upstream-tool";
import type { SendContext, SendCredential } from "../../sender";
import type { Transport } from "../../transport";
import { LEDGER_DESCRIPTOR_SET } from "./ledger-descriptor-set";

const PACKAGE = "a_intel.ledger.v1";
const SERVICE = `${PACKAGE}.Ledger`;

function template(
  method: string,
  streaming: GrpcRequest["streaming"],
  idempotency_level: GrpcRequest["idempotency_level"],
  request: string,
  response: string,
): GrpcRequest {
  return {
    kind: "grpc",
    method: `${SERVICE}/${method}`,
    streaming,
    idempotency_level,
    request_type: `${PACKAGE}.${request}`,
    response_type: `${PACKAGE}.${response}`,
  };
}

/** Unary and NO_SIDE_EFFECTS: retried. */
export const GET_ENTRY = template("GetEntry", "unary", "NO_SIDE_EFFECTS", "GetEntryRequest", "Entry");
/** Unary with no idempotency level: never retried. */
export const POST_ENTRY = template("PostEntry", "unary", "IDEMPOTENCY_UNKNOWN", "PostEntryRequest", "Entry");
/** Unary and IDEMPOTENT: retried. */
export const REVERSE_ENTRY = template("ReverseEntry", "unary", "IDEMPOTENT", "ReverseEntryRequest", "Entry");
/** A server stream, NO_SIDE_EFFECTS: retried until it sends an item. */
export const LIST_ENTRIES = template("ListEntries", "server", "NO_SIDE_EFFECTS", "ListEntriesRequest", "Entry");
/** A client stream, which never becomes a tool. */
export const UPLOAD_ENTRIES = template("UploadEntries", "unary", "IDEMPOTENCY_UNKNOWN", "PostEntryRequest", "UploadSummary");

/** An api_key scheme that sends the key in the x-api-key header. */
export const API_KEY_AUTH: ManifestAuth = {
  mode: "service",
  scheme: "key",
  apply: { type: "api_key", in: "header", name: "X-Api-Key" },
};

export interface LedgerContextOptions {
  transport: Transport;
  /** The environment url. Set the key to undefined for an environment with no url. */
  url?: string | undefined;
  network?: string;
  auth?: ManifestAuth | null;
  credential?: SendCredential;
  deadline_ms?: number;
  max_items?: number;
  /** The server's descriptor set. Set the key to undefined for a server with none. */
  descriptor_set?: string | undefined;
  signal?: AbortSignal;
}

/** A SendContext for the ledger server. Only the fields the grpc Sender reads are real. */
export function ledgerContext(options: LedgerContextOptions): SendContext {
  const shaping: ManifestShaping = {
    hide: [],
    fixed: {},
    defaults: {},
    rename: {},
    select: [],
    redact: [],
    max_result_bytes: 65_536,
    deadline_ms: options.deadline_ms ?? 30_000,
  };
  if (options.max_items !== undefined) shaping.max_items = options.max_items;
  const descriptorSet = "descriptor_set" in options ? options.descriptor_set : LEDGER_DESCRIPTOR_SET;
  // The Sender reads only descriptor_set from the server entry.
  const server = { name: "ledger", descriptor_set: descriptorSet } as unknown as ManifestServer;
  return {
    server,
    environment: {
      name: "sandbox",
      url: "url" in options ? options.url : "http://127.0.0.1:50051",
      network: options.network ?? "cloud",
    },
    auth: options.auth ?? null,
    credential: options.credential ?? { type: "none" },
    transport: options.transport,
    shaping,
    idempotency_key: undefined,
    signal: options.signal ?? new AbortController().signal,
  };
}
