// index.ts: the senders the relay uses to reach the customer's servers.
import { createGrpcUpstream } from "./grpc";
import { createHttpUpstream } from "./http";
import type { Upstreams } from "./types";

export type { RelayGrpcTarget, RelayHttpTarget, UpstreamCall, Upstreams } from "./types";

export interface UpstreamOptions {
  maxResponseBytes: number;
}

/** The HTTP and gRPC senders together. */
export function createUpstreams(options: UpstreamOptions): Upstreams {
  const http = createHttpUpstream();
  const grpc = createGrpcUpstream({ maxResponseBytes: options.maxResponseBytes });
  return {
    http: (call) => http.send(call),
    grpc: (call) => grpc.send(call),
    close: () => {
      http.close();
      grpc.close();
    },
  };
}
