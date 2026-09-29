// grpc.ts: send one gRPC call upstream over HTTP/2 and stream its messages back.
//
// The relay calls exactly the service and method the envelope names, with the
// signed metadata and the one request message. It uses @grpc/grpc-js as a
// byte-level client, as mcp-studio's carrier does: the serializers pass bytes
// through, so the relay needs no generated code and never decodes a message.
// An https target dials with TLS against Node's trusted roots, and an http
// target dials cleartext HTTP/2.
//
// Each response message goes back as one data frame. The call's status goes
// back as the trailers frame, after the last message.
import { Client, credentials, Metadata, type StatusObject } from "@grpc/grpc-js";
import type { HeaderEntry } from "../credentials";
import { MAX_GRPC_MESSAGE_BYTES } from "../sink";
import { messageOf, type RelayGrpcTarget, type UpstreamCall } from "./types";

export interface GrpcUpstreamOptions {
  /** The relay's response cap. No single message may be larger. */
  maxResponseBytes: number;
}

export interface GrpcUpstream {
  send(call: UpstreamCall<RelayGrpcTarget>): void;
  close(): void;
}

/**
 * How long grpc-js waits past the envelope's deadline before it ends the call
 * itself. The relay's own timer fires first and reports the timeout. This is
 * only a backstop, so a call can never outlive its envelope by long.
 */
const GRPC_DEADLINE_GRACE_MS = 1_000;

/** The address grpc-js dials: the host by name, at its port or the scheme's default. */
export function grpcDialAddress(target: RelayGrpcTarget): string {
  const port = target.port ?? (target.scheme === "https" ? 443 : 80);
  return `dns:${target.host}:${port}`;
}

/** The metadata as grpc-js takes it. A -bin value arrives as base64 and goes out as bytes. */
export function grpcMetadata(entries: readonly HeaderEntry[]): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (key.endsWith("-bin")) metadata.add(key, Buffer.from(value, "base64"));
    else metadata.add(key, value);
  }
  return metadata;
}

/** The metadata as header entries. A -bin value goes back as base64. */
export function metadataEntries(metadata: Metadata): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  for (const name of Object.keys(metadata.getMap())) {
    for (const value of metadata.get(name)) {
      entries.push([name, typeof value === "string" ? value : Buffer.from(value).toString("base64")]);
    }
  }
  return entries;
}

/** A gRPC sender. Each call opens its own channel and closes it when the call ends. */
export function createGrpcUpstream(options: GrpcUpstreamOptions): GrpcUpstream {
  const open = new Set<Client>();
  return {
    send: (call) => sendGrpc(call, options, open),
    close: () => {
      for (const client of open) client.close();
      open.clear();
    },
  };
}

function sendGrpc(call: UpstreamCall<RelayGrpcTarget>, options: GrpcUpstreamOptions, open: Set<Client>): void {
  const { target, sink, signal, deadlineMs } = call;
  if (signal.aborted) return;

  let metadata: Metadata;
  try {
    metadata = grpcMetadata(call.headers);
  } catch (error) {
    // grpc-js refuses a metadata name or value it cannot send. Its message
    // names the key, never the value.
    sink.fail("upstream", `The call metadata is not valid: ${messageOf(error)}`, false);
    return;
  }

  const client = new Client(
    grpcDialAddress(target),
    target.scheme === "https" ? credentials.createSsl(null) : credentials.createInsecure(),
    {
      // grpc-js refuses a larger message with RESOURCE_EXHAUSTED, which the
      // broker reads as a response too large to carry.
      "grpc.max_receive_message_length": Math.min(options.maxResponseBytes, MAX_GRPC_MESSAGE_BYTES),
    },
  );
  open.add(client);
  const stream = client.makeServerStreamRequest<Uint8Array, Uint8Array>(
    `/${target.service}/${target.method}`,
    (message) => Buffer.from(message.buffer, message.byteOffset, message.byteLength),
    (bytes) => bytes,
    call.body,
    metadata,
    { deadline: Date.now() + deadlineMs + GRPC_DEADLINE_GRACE_MS },
  );

  let status: StatusObject | undefined;
  let ended = false;
  const cancel = (): void => stream.cancel();
  const timer = setTimeout(() => {
    // A gRPC call is sent once it starts, since grpc-js queues the request
    // for the connection at once.
    sink.fail("timeout", `${target.host} did not finish the call within the envelope's ${deadlineMs} ms deadline.`, true);
    cancel();
  }, deadlineMs);
  signal.addEventListener("abort", cancel, { once: true });

  // grpc-js emits status as soon as it arrives and ends the stream only
  // after the last message is read. The trailers wait for both, so they
  // always follow the last data frame.
  const finish = (): void => {
    if (status === undefined || !ended) return;
    sink.trailers(status.code, status.details, metadataEntries(status.metadata));
  };

  stream.on("metadata", (received: Metadata) => sink.head(200, metadataEntries(received)));
  stream.on("data", (message: Uint8Array) => {
    // Read no further message until the broker's connection has room for
    // this one. The sink sends the frame before it waits.
    stream.pause();
    void sink.data(message).then((more) => {
      if (more) stream.resume();
      else cancel();
    });
  });
  stream.on("end", () => {
    ended = true;
    finish();
  });
  stream.on("status", (received: StatusObject) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    open.delete(client);
    client.close();
    status = received;
    finish();
  });
  // grpc-js emits error and then status for a status other than OK. The
  // status carries the same code, so this listener only keeps the error from
  // being thrown as an unhandled event.
  stream.on("error", () => undefined);
}
