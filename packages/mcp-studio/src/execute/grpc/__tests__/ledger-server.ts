// ledger-server.ts: an in-process gRPC server for the ledger fixture, for the
// grpc Sender's tests.
//
// It serves a_intel.ledger.v1.Ledger from the same descriptor set the Sender
// reads, so no generated code is involved on either side. Each test sets the
// handlers it needs. The server records every call it receives, with its
// request as JSON and its metadata.
import {
  createFileRegistry,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type DescMessage,
  type JsonObject,
  type JsonValue,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import {
  Server,
  ServerCredentials,
  type Metadata,
  type MethodDefinition,
  type sendUnaryData,
  type ServerUnaryCall,
  type ServerWritableStream,
  type ServiceDefinition,
  type UntypedServiceImplementation,
} from "@grpc/grpc-js";
import { LEDGER_DESCRIPTOR_SET } from "./ledger-descriptor-set";

export const LEDGER_SERVICE = "a_intel.ledger.v1.Ledger";

/** Throw it from a handler to end the call with this status. */
export class GrpcFailure extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "GrpcFailure";
    this.code = code;
  }
}

export interface ReceivedCall {
  method: string;
  request: JsonValue;
  metadata: Record<string, string[]>;
}

export interface HandlerContext {
  call: ReceivedCall;
  /** Resolves when the client cancels the call or its deadline passes. */
  cancelled: Promise<void>;
}

export type UnaryHandler = (request: JsonObject, context: HandlerContext) => JsonObject | Promise<JsonObject>;

export interface StreamContext extends HandlerContext {
  write(message: JsonObject): void;
}

/** Write messages, then return to end the stream with OK, or throw to end it with a status. */
export type StreamHandler = (request: JsonObject, context: StreamContext) => void | Promise<void>;

export interface LedgerHandlers {
  GetEntry?: UnaryHandler;
  PostEntry?: UnaryHandler;
  ReverseEntry?: UnaryHandler;
  ListEntries?: StreamHandler;
}

export interface LedgerServer {
  port: number;
  /** Replace these between tests. A method with no handler ends with UNIMPLEMENTED. */
  handlers: LedgerHandlers;
  /** Every call received, in order. */
  calls: ReceivedCall[];
  callsTo(method: keyof LedgerHandlers): ReceivedCall[];
  close(): void;
}

export interface LedgerServerOptions {
  /** Serve TLS with this PEM key and certificate. Cleartext HTTP/2 without it. */
  tls?: { key: Buffer; cert: Buffer };
}

const registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, Buffer.from(LEDGER_DESCRIPTOR_SET, "base64")));
const STATUS_INTERNAL = 13;
const STATUS_UNIMPLEMENTED = 12;

function messageType(typeName: string): DescMessage {
  const message = registry.getMessage(typeName);
  if (message === undefined) throw new Error(`The ledger descriptor set has no message ${typeName}.`);
  return message;
}

function decode(typeName: string, bytes: Buffer): JsonObject {
  const json = toJson(messageType(typeName), fromBinary(messageType(typeName), bytes), { registry });
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`${typeName} did not decode to a JSON object.`);
  }
  return json;
}

function encode(typeName: string, json: JsonObject): Buffer {
  return Buffer.from(toBinary(messageType(typeName), fromJson(messageType(typeName), json, { registry })));
}

function metadataMap(metadata: Metadata): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const name of Object.keys(metadata.getMap())) {
    map[name] = metadata.get(name).map((value) => (typeof value === "string" ? value : value.toString("base64")));
  }
  return map;
}

function failureStatus(error: unknown): { code: number; details: string } {
  if (error instanceof GrpcFailure) return { code: error.code, details: error.message };
  return { code: STATUS_INTERNAL, details: error instanceof Error ? error.message : String(error) };
}

const identity = (bytes: Buffer): Buffer => bytes;

function method(name: string, responseStream: boolean): MethodDefinition<Buffer, Buffer> {
  return {
    path: `/${LEDGER_SERVICE}/${name}`,
    requestStream: false,
    responseStream,
    requestSerialize: identity,
    requestDeserialize: identity,
    responseSerialize: identity,
    responseDeserialize: identity,
  };
}

/** Start the server on 127.0.0.1 and a free port. */
export async function startLedgerServer(options: LedgerServerOptions = {}): Promise<LedgerServer> {
  const calls: ReceivedCall[] = [];
  const state: LedgerServer = {
    port: 0,
    handlers: {},
    calls,
    callsTo: (name) => calls.filter((call) => call.method === name),
    close: () => server.forceShutdown(),
  };

  const receive = (name: string, requestType: string, request: Buffer, metadata: Metadata): ReceivedCall => {
    const call: ReceivedCall = { method: name, request: decode(requestType, request), metadata: metadataMap(metadata) };
    calls.push(call);
    return call;
  };

  const unary =
    (name: "GetEntry" | "PostEntry" | "ReverseEntry", requestType: string) =>
    (call: ServerUnaryCall<Buffer, Buffer>, callback: sendUnaryData<Buffer>): void => {
      const received = receive(name, requestType, call.request, call.metadata);
      const cancelled = new Promise<void>((resolve) => call.once("cancelled", () => resolve()));
      const handler = state.handlers[name];
      if (handler === undefined) {
        callback({ code: STATUS_UNIMPLEMENTED, details: `No handler for ${name}.` });
        return;
      }
      Promise.resolve()
        .then(() => handler(decode(requestType, call.request), { call: received, cancelled }))
        .then(
          (response) => callback(null, encode("a_intel.ledger.v1.Entry", response)),
          (error: unknown) => callback(failureStatus(error)),
        );
    };

  const listEntries = (call: ServerWritableStream<Buffer, Buffer>): void => {
    const requestType = "a_intel.ledger.v1.ListEntriesRequest";
    const received = receive("ListEntries", requestType, call.request, call.metadata);
    const cancelled = new Promise<void>((resolve) => call.once("cancelled", () => resolve()));
    const handler = state.handlers.ListEntries;
    if (handler === undefined) {
      call.emit("error", { code: STATUS_UNIMPLEMENTED, details: "No handler for ListEntries." });
      return;
    }
    const write = (message: JsonObject): void => {
      if (!call.cancelled) call.write(encode("a_intel.ledger.v1.Entry", message));
    };
    Promise.resolve()
      .then(() => handler(decode(requestType, call.request), { call: received, cancelled, write }))
      .then(
        () => call.end(),
        (error: unknown) => call.emit("error", failureStatus(error)),
      );
  };

  const definition: ServiceDefinition = {
    GetEntry: method("GetEntry", false),
    PostEntry: method("PostEntry", false),
    ReverseEntry: method("ReverseEntry", false),
    ListEntries: method("ListEntries", true),
  };
  const implementation: UntypedServiceImplementation = {
    GetEntry: unary("GetEntry", "a_intel.ledger.v1.GetEntryRequest"),
    PostEntry: unary("PostEntry", "a_intel.ledger.v1.PostEntryRequest"),
    ReverseEntry: unary("ReverseEntry", "a_intel.ledger.v1.ReverseEntryRequest"),
    ListEntries: listEntries,
  };

  const server = new Server();
  server.addService(definition, implementation);
  const credentials =
    options.tls === undefined
      ? ServerCredentials.createInsecure()
      : ServerCredentials.createSsl(null, [{ private_key: options.tls.key, cert_chain: options.tls.cert }], false);
  state.port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", credentials, (error, port) => (error === null ? resolve(port) : reject(error)));
  });
  return state;
}

/** An Entry as the server returns it, with the fields a test reads. */
export function entry(id: string, fields: JsonObject = {}): JsonObject {
  return { id, accountId: "acct_1", kind: "ENTRY_KIND_DEBIT", money: { amount: "1250", currency: "USD" }, ...fields };
}
