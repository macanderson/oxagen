// carrier.ts: a Transport that sends gRPC calls straight to the upstream over
// HTTP/2, for the cloud network.
//
// It uses @grpc/grpc-js, the gRPC project's own implementation for Node, as
// a byte-level client: the serializers pass bytes through, so no generated
// code is involved and the grpc Sender does all the encoding. An https target
// dials with TLS, and an http target dials cleartext HTTP/2.
//
// The carrier does not decide which addresses the cloud may reach. The cloud
// Transport (M6) passes a `resolve` hook that refuses private, loopback, and
// link-local addresses and returns the address to dial. The carrier dials that
// address and keeps the host for the :authority header and TLS verification,
// so a second DNS lookup cannot move the call to another address.
import { isIPv6 } from "node:net";
import {
  Client,
  credentials,
  Metadata,
  type ChannelCredentials,
  type ChannelOptions,
  type ClientReadableStream,
  type StatusObject,
} from "@grpc/grpc-js";
import {
  TransportError,
  type GrpcStatus,
  type GrpcTarget,
  type GrpcTransportRequest,
  type GrpcTransportResponse,
  type HeaderEntry,
  type Transport,
} from "../transport";
import { messageOf } from "./descriptors";

export interface GrpcCarrierOptions {
  /**
   * Return the IP address to dial for a host, or throw a TransportError such
   * as refused_address. Without it, the carrier dials the host by name.
   */
  resolve?: (host: string, signal: AbortSignal) => Promise<string>;
  /** PEM root certificates to trust in place of the system's. */
  root_certs?: Uint8Array;
}

// The carrier stops reading from the connection while this many messages
// wait for the Sender, and reads again when the Sender has taken them.
const QUEUE_HIGH_WATER = 16;
const QUEUE_LOW_WATER = 4;

/** A Transport that carries gRPC calls on the cloud network. It refuses HTTP and local calls. */
export function createGrpcCarrier(options: GrpcCarrierOptions = {}): Transport {
  return {
    http: () =>
      Promise.reject(new TransportError("unsupported", "The gRPC carrier sends gRPC calls only.", false)),
    local: () =>
      Promise.reject(new TransportError("unsupported", "The gRPC carrier sends gRPC calls only.", false)),
    grpc: (request) => sendCall(request, options),
  };
}

/** The address grpc-js dials: a pinned IPv4 or IPv6 address, or the host by name. */
export function dialAddress(target: GrpcTarget, ip: string | undefined): string {
  const port = target.port ?? (target.scheme === "https" ? 443 : 80);
  if (ip === undefined) return `dns:${target.host}:${port}`;
  return isIPv6(ip) ? `ipv6:[${ip}]:${port}` : `ipv4:${ip}:${port}`;
}

function channelCredentials(target: GrpcTarget, rootCerts: Uint8Array | undefined): ChannelCredentials {
  if (target.scheme === "http") return credentials.createInsecure();
  return credentials.createSsl(rootCerts === undefined ? null : Buffer.from(rootCerts));
}

async function sendCall(request: GrpcTransportRequest, options: GrpcCarrierOptions): Promise<GrpcTransportResponse> {
  const { target, signal } = request;
  if (request.network !== "cloud") {
    throw new TransportError(
      "unsupported",
      `The gRPC carrier sends on the cloud network only, and this call is for ${request.network}.`,
      false,
    );
  }
  const channelOptions: ChannelOptions = {};
  let ip: string | undefined;
  if (options.resolve !== undefined) {
    try {
      ip = await options.resolve(target.host, signal);
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError("not_sent", `${target.host} did not resolve: ${messageOf(error)}`, false);
    }
    // Dial the pinned address, and name the host in :authority and in TLS.
    channelOptions["grpc.default_authority"] =
      target.port === undefined ? target.host : `${target.host}:${target.port}`;
    if (target.scheme === "https") channelOptions["grpc.ssl_target_name_override"] = target.host;
  }
  if (signal.aborted) {
    throw new TransportError("not_sent", "The call was cancelled before it was sent.", false);
  }

  const metadata = new Metadata();
  try {
    for (const [name, value] of request.metadata) metadata.add(name, value);
  } catch (error) {
    throw new TransportError("not_sent", `The call metadata is not valid: ${messageOf(error)}`, false);
  }

  const client = new Client(dialAddress(target, ip), channelCredentials(target, options.root_certs), channelOptions);
  const call = client.makeServerStreamRequest<Uint8Array, Uint8Array>(
    `/${target.service}/${target.method}`,
    (message) => Buffer.from(message.buffer, message.byteOffset, message.byteLength),
    (bytes) => bytes,
    request.message,
    metadata,
    { deadline: Date.now() + request.deadline_ms },
  );

  const cancel = (): void => call.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const status = new Promise<GrpcStatus>((resolve) => {
    call.on("status", (received: StatusObject) => {
      signal.removeEventListener("abort", cancel);
      client.close();
      resolve({ code: received.code, message: received.details, metadata: metadataEntries(received.metadata) });
    });
  });
  // grpc-js emits "error" and then "status" for a status other than OK. The
  // status event carries the same code, so this listener only keeps the error
  // from being thrown as an unhandled event.
  call.on("error", () => undefined);

  return { messages: readMessages(call), status: () => status, cancel };
}

/** The call's messages in order. Ends when the call ends. Never throws. */
async function* readMessages(call: ClientReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const queue: Uint8Array[] = [];
  let ended = false;
  let paused = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  call.on("data", (message: Uint8Array) => {
    queue.push(message);
    if (queue.length >= QUEUE_HIGH_WATER && !paused) {
      paused = true;
      call.pause();
    }
    notify();
  });
  // grpc-js ends the stream when the status arrives, after the last message.
  call.on("end", () => {
    ended = true;
    notify();
  });

  for (;;) {
    if (paused && queue.length <= QUEUE_LOW_WATER) {
      paused = false;
      call.resume();
    }
    const message = queue.shift();
    if (message !== undefined) {
      yield message;
    } else if (ended) {
      return;
    } else {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
}

function metadataEntries(metadata: Metadata): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  for (const name of Object.keys(metadata.getMap())) {
    for (const value of metadata.get(name)) {
      entries.push([name, typeof value === "string" ? value : Buffer.from(value).toString("base64")]);
    }
  }
  return entries;
}
