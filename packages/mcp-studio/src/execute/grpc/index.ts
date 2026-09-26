// execute/grpc: the grpc Sender (lane M7).
//
// It encodes the request from JSON and decodes each response message to JSON
// by the proto3 JSON mapping, using the server's descriptor_set from the
// manifest, with no generated code. It sends through the Transport, reads a
// server stream until it ends, reaches shaping.max_items, or passes
// deadline_ms, and returns { items, truncated } for a stream. It retries
// UNAVAILABLE up to 3 times only for NO_SIDE_EFFECTS and IDEMPOTENT methods.
import { notBuiltAsync } from "../../not-built";
import type { Sender } from "../sender";

/** A server stream's result: the messages read, and whether the stream was cut. */
export interface GrpcStreamResult {
  items: unknown[];
  truncated: boolean;
}

export const grpcSender: Sender<"grpc"> = {
  kind: "grpc",
  send: (template, args, context) => notBuiltAsync("execute/grpc", template, args, context),
};
