// call.ts: one call the broker sent to a relay, from the request frame to
// the last frame of its response.
//
// A call settles once. The first of these ends it: the response's last frame,
// a refusal, a failure, the deadline, a cancel from the caller, or the loss of
// the connection. Whatever arrives after that is dropped. The errors follow
// the cloud transport, so MCP treats a relay call like any other:
//
// - Before the relay starts the call, a refusal or a failure the relay says
//   was not sent rejects with a TransportError whose `sent` is false.
// - A lost connection or a passed deadline rejects with a TransportError whose
//   `sent` is true, since the upstream may have the request.
// - A cancel after the send rejects with a plain Error.
// - After the head, an HTTP body throws the failure. A gRPC call never throws
//   from its messages. Its status says how it ended instead.
import {
  TransportError,
  type GrpcStatus,
  type HeaderEntry,
  type TransportErrorCode,
} from "@oxagen/mcp-studio";
import type { RelayFailureCode, RelayFrame, RelayRefusalCode } from "./protocol/frames";
import { fromBase64 } from "./protocol/frames";

/** gRPC status codes the broker reports when a call ends without trailers. */
export const GRPC_CANCELLED = 1;
export const GRPC_DEADLINE_EXCEEDED = 4;
export const GRPC_RESOURCE_EXHAUSTED = 8;
export const GRPC_UNAVAILABLE = 14;

/** Response parts in arrival order, read by one consumer. */
export class ChunkQueue {
  private readonly chunks: Uint8Array[] = [];
  private done = false;
  private error: Error | undefined;
  private wake: (() => void) | undefined;

  push(chunk: Uint8Array): void {
    if (this.done) return;
    this.chunks.push(chunk);
    this.notify();
  }

  /** No more parts. With an error, the reader throws it after the parts already queued. */
  end(error?: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    this.notify();
  }

  /** Drop what is queued and end without an error. */
  discard(): void {
    this.chunks.length = 0;
    this.end();
  }

  async *read(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.chunks.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

export interface CallHead {
  status: number;
  headers: readonly HeaderEntry[];
}

export interface CallOptions {
  id: string;
  kind: "http" | "grpc";
  relay: string;
  /** The envelope's deadline_ms. The broker waits this long plus a grace for the relay's own timeout. */
  deadlineMs: number;
  graceMs: number;
  signal: AbortSignal;
  /** Tell the relay to stop the call. */
  sendCancel(): void;
  /** Forget the call once it ends. */
  onSettled(): void;
}

function refusalError(code: RelayRefusalCode, message: string): TransportError {
  const transportCode: TransportErrorCode = code === "host_not_allowed" ? "refused_host" : "not_sent";
  return new TransportError(transportCode, `Relay refused the call (${code}): ${message}`, false);
}

const FAILURE_STATUS: Record<RelayFailureCode, number> = {
  timeout: GRPC_DEADLINE_EXCEEDED,
  upstream: GRPC_UNAVAILABLE,
  too_large: GRPC_RESOURCE_EXHAUSTED,
  cancelled: GRPC_CANCELLED,
};

export class RelayCall {
  readonly id: string;
  readonly kind: "http" | "grpc";
  readonly head: Promise<CallHead>;
  readonly body = new ChunkQueue();
  private readonly options: CallOptions;
  private resolveHead!: (head: CallHead) => void;
  private rejectHead!: (error: Error) => void;
  private headArrived = false;
  private settled = false;
  private grpcStatus: GrpcStatus | undefined;
  private readonly statusWaiters: ((status: GrpcStatus) => void)[] = [];
  private readonly timer: NodeJS.Timeout;
  private readonly onAbort: () => void;

  constructor(options: CallOptions) {
    this.options = options;
    this.id = options.id;
    this.kind = options.kind;
    this.head = new Promise<CallHead>((resolve, reject) => {
      this.resolveHead = resolve;
      this.rejectHead = reject;
    });
    // A caller that never awaits the head must not see an unhandled rejection.
    this.head.catch(() => undefined);
    this.timer = setTimeout(() => this.timeOut(), options.deadlineMs + options.graceMs);
    this.onAbort = () => this.abortedByCaller();
    options.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Apply one frame the relay sent for this call. */
  receive(frame: RelayFrame): void {
    if (this.settled) return;
    switch (frame.type) {
      case "head":
        if (this.headArrived) return;
        this.headArrived = true;
        this.resolveHead({ status: frame.status, headers: frame.headers });
        return;
      case "data":
        if (this.headArrived) this.body.push(fromBase64(frame.chunk));
        return;
      case "end":
        this.settle({ code: 0, message: "", metadata: [] });
        return;
      case "trailers":
        this.settle({ code: frame.code, message: frame.message, metadata: frame.metadata });
        return;
      case "refused":
        this.fail(refusalError(frame.code, frame.message), GRPC_UNAVAILABLE);
        return;
      case "fail":
        this.relayFailed(frame.code, frame.message, frame.sent);
        return;
      default:
        return;
    }
  }

  /** The connection closed while the call was open. */
  disconnected(): void {
    if (this.settled) return;
    this.fail(
      new TransportError(
        "disconnected",
        `The connection to relay ${this.options.relay} closed after the call was sent.`,
        true,
      ),
      GRPC_UNAVAILABLE,
    );
  }

  /** The caller stopped reading: an HTTP response's cancel(), or a gRPC call's. */
  cancel(): void {
    if (this.settled) return;
    this.options.sendCancel();
    this.finish();
    this.body.discard();
    this.resolveStatus({ code: GRPC_CANCELLED, message: "The call was cancelled.", metadata: [] });
    this.rejectHead(new Error("The call was cancelled after it was sent."));
  }

  /** How a gRPC call ended. Resolves once it ends, and never rejects. */
  status(): Promise<GrpcStatus> {
    if (this.grpcStatus) return Promise.resolve(this.grpcStatus);
    return new Promise((resolve) => this.statusWaiters.push(resolve));
  }

  private relayFailed(code: RelayFailureCode, message: string, sent: boolean): void {
    const text = `Relay ${this.options.relay} could not complete the call (${code}): ${message}`;
    let error: Error;
    if (code === "timeout") error = new TransportError("timeout", text, sent);
    else if (!this.headArrived && !sent) error = new TransportError("not_sent", text, false);
    else error = new Error(text);
    this.fail(error, FAILURE_STATUS[code], message);
  }

  private timeOut(): void {
    if (this.settled) return;
    this.options.sendCancel();
    this.fail(
      new TransportError(
        "timeout",
        `Relay ${this.options.relay} sent no complete response within ${this.options.deadlineMs} ms.`,
        true,
      ),
      GRPC_DEADLINE_EXCEEDED,
    );
  }

  private abortedByCaller(): void {
    if (this.settled) return;
    this.options.sendCancel();
    this.fail(new Error("The call was cancelled after it was sent."), GRPC_CANCELLED);
  }

  /**
   * End the call with an error. Before the head, the caller's promise rejects
   * with it. After the head, an HTTP body throws it, and a gRPC call ends with
   * the status code instead.
   */
  private fail(error: Error, grpcCode: number, grpcMessage = error.message): void {
    if (this.settled) return;
    this.finish();
    if (!this.headArrived) {
      this.rejectHead(error);
      this.body.end(error);
    } else if (this.kind === "http") {
      this.body.end(error);
    } else {
      this.body.end();
    }
    this.resolveStatus({ code: grpcCode, message: grpcMessage, metadata: [] });
  }

  private settle(status: GrpcStatus): void {
    if (this.settled) return;
    this.finish();
    if (!this.headArrived) {
      // A relay that ends a call without a head has broken the protocol.
      const error = new Error(`Relay ${this.options.relay} ended the call before it sent a response head.`);
      this.rejectHead(error);
      this.body.end(error);
      this.resolveStatus({ code: GRPC_UNAVAILABLE, message: error.message, metadata: [] });
      return;
    }
    this.body.end();
    this.resolveStatus(status);
  }

  private resolveStatus(status: GrpcStatus): void {
    if (this.grpcStatus) return;
    this.grpcStatus = status;
    for (const resolve of this.statusWaiters.splice(0)) resolve(status);
  }

  private finish(): void {
    this.settled = true;
    clearTimeout(this.timer);
    this.options.signal.removeEventListener("abort", this.onAbort);
    this.options.onSettled();
  }
}
