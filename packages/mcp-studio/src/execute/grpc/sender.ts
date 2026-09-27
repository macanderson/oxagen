// sender.ts: the grpc Sender (mcp-studio-spec, Mapping (gRPC), and Call path,
// step 5).
//
// A send builds the call once: it resolves the method in the server's
// descriptor set, builds the target and the call metadata, and encodes the
// arguments. Then it makes up to four attempts through the Transport, all
// inside one deadline of shaping.deadline_ms.
//
// A unary call returns its one response message as JSON. A server stream is
// read until it ends, reaches max_items, or passes the deadline, and returns
// { items, truncated }. A status other than OK becomes an error that names
// the status and carries the upstream's message.
//
// UNAVAILABLE is retried up to 3 times, and only for a method the descriptor
// set marks NO_SIDE_EFFECTS or IDEMPOTENT, since the upstream may have acted
// on a call that failed. A stream that already sent an item is not retried.
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { MAX_ITEMS_LIMIT, MAX_RESULT_BYTES_LIMIT } from "../../contract/tools";
import type { GrpcIdempotencyLevel, GrpcRequest } from "../../model/upstream-tool";
import type { SendContext, SendError, Sender, SendResult, UpstreamArguments } from "../sender";
import {
  TransportError,
  type GrpcStatus,
  type GrpcTransportRequest,
  type GrpcTransportResponse,
  type Transport,
  type TransportErrorCode,
} from "../transport";
import { decodeResponse, encodeRequest, messageOf, resolveMethod, type ResolvedMethod } from "./descriptors";
import { buildCredentials, buildTarget, RequestError, type CallCredentials } from "./request";
import {
  STATUS_CANCELLED,
  STATUS_DEADLINE_EXCEEDED,
  STATUS_INTERNAL,
  STATUS_OK,
  STATUS_UNAVAILABLE,
  statusName,
} from "./status";

/** A server stream's result: the messages read, and whether the stream was cut. */
export interface GrpcStreamResult {
  items: unknown[];
  truncated: boolean;
}

export interface GrpcSenderOptions {
  /** The wait in milliseconds before retry n, where n is 1, 2, or 3. 100, 200, and 400 by default. */
  backoff_ms?: (retry: number) => number;
  /** The decoded JSON bytes a stream may collect before it is cut. 16 MiB by default. */
  max_stream_bytes?: number;
}

/** The first attempt and 3 retries. */
const MAX_ATTEMPTS = 4;

/**
 * A stream stops at this much decoded JSON even when max_items allows more,
 * so one call cannot hold unbounded memory. select and redact run after the
 * Sender and can shrink a result, so the cap sits well above the largest
 * max_result_bytes a tool can set.
 */
const DEFAULT_MAX_STREAM_BYTES = 16 * MAX_RESULT_BYTES_LIMIT;

const RETRIED_LEVELS: ReadonlySet<GrpcIdempotencyLevel> = new Set<GrpcIdempotencyLevel>([
  "NO_SIDE_EFFECTS",
  "IDEMPOTENT",
]);

// setTimeout fires at once for a delay above 2^31 - 1 ms.
const MAX_TIMER_MS = 2_147_483_647;

const CANCELLED: SendError = {
  title: statusName(STATUS_CANCELLED),
  detail: "The call was cancelled before it finished.",
  status: STATUS_CANCELLED,
};

interface Settings {
  backoff_ms: (retry: number) => number;
  max_stream_bytes: number;
}

/** Build a grpc Sender. The options exist for tests. */
export function createGrpcSender(options: GrpcSenderOptions = {}): Sender<"grpc"> {
  const settings: Settings = {
    backoff_ms: options.backoff_ms ?? ((retry) => 100 * 2 ** (retry - 1)),
    max_stream_bytes: options.max_stream_bytes ?? DEFAULT_MAX_STREAM_BYTES,
  };
  return {
    kind: "grpc",
    // A Sender never rejects. The catch turns a defect into an error result.
    send: async (template, args, context) => {
      try {
        return await send(template, args, context, settings);
      } catch (error) {
        return {
          ok: false,
          error: { title: "Internal error", detail: `The gRPC Sender failed: ${messageOf(error)}`, status: undefined },
          attempts: 0,
        };
      }
    },
  };
}

export const grpcSender: Sender<"grpc"> = createGrpcSender();

/** Everything an attempt sends. Built once per send. */
interface Call {
  template: GrpcRequest;
  method: ResolvedMethod;
  request: Omit<GrpcTransportRequest, "deadline_ms" | "signal">;
  deadline_ms: number;
  max_items: number;
}

type Prepared = { ok: true; call: Call } | { ok: false; error: SendError };

/** One attempt's result. retryable means the upstream sent no item and reported UNAVAILABLE. */
type Attempt = { ok: true; value: unknown } | { ok: false; error: SendError; retryable: boolean };

async function send(
  template: GrpcRequest,
  args: UpstreamArguments,
  context: SendContext,
  settings: Settings,
): Promise<SendResult> {
  const prepared = prepare(template, args, context);
  if (!prepared.ok) return { ok: false, error: prepared.error, attempts: 0 };
  const deadline = Date.now() + context.shaping.deadline_ms;
  // The level comes from the descriptor set, which resolveMethod checked the template against.
  const retried = RETRIED_LEVELS.has(prepared.call.method.idempotency_level);
  for (let attempt = 1; ; attempt += 1) {
    const result = await attemptCall(prepared.call, context, deadline, settings);
    if (result.ok) return { ok: true, value: result.value, attempts: attempt };
    if (!result.retryable || !retried || attempt >= MAX_ATTEMPTS) {
      return { ok: false, error: result.error, attempts: attempt };
    }
    const wait = settings.backoff_ms(attempt);
    // A retry that cannot start before the deadline would only fail again.
    if (Date.now() + wait >= deadline) return { ok: false, error: result.error, attempts: attempt };
    if (!(await sleep(wait, context.signal))) return { ok: false, error: CANCELLED, attempts: attempt };
    // A timer can fire late, so check the deadline again after the wait.
    if (Date.now() >= deadline) return { ok: false, error: result.error, attempts: attempt };
  }
}

function prepare(template: GrpcRequest, args: UpstreamArguments, context: SendContext): Prepared {
  let method: ResolvedMethod;
  try {
    method = resolveMethod(context.server.descriptor_set, template);
  } catch (error) {
    return { ok: false, error: { title: "Invalid descriptor set", detail: messageOf(error), status: undefined } };
  }
  let request: Omit<Call["request"], "message">;
  let credentials: CallCredentials;
  try {
    credentials = buildCredentials(context.auth, context.credential, context.environment.network);
    request = {
      network: context.environment.network,
      relay_credential: credentials.relay_credential,
      target: buildTarget(context.environment.url, template.method),
      metadata: credentials.metadata,
    };
  } catch (error) {
    const title = error instanceof RequestError ? error.title : "Invalid request";
    return { ok: false, error: { title, detail: messageOf(error), status: undefined } };
  }
  let message: Uint8Array;
  try {
    // execute() hands over the agent's JSON input after shaping.
    message = encodeRequest(method, args as JsonObject);
  } catch (error) {
    return { ok: false, error: { title: "Invalid arguments", detail: messageOf(error), status: undefined } };
  }
  return {
    ok: true,
    call: {
      template,
      method,
      request: { ...request, message },
      deadline_ms: context.shaping.deadline_ms,
      max_items: template.streaming === "server" ? (context.shaping.max_items ?? MAX_ITEMS_LIMIT) : 1,
    },
  };
}

async function attemptCall(call: Call, context: SendContext, deadline: number, settings: Settings): Promise<Attempt> {
  const controller = new AbortController();
  const clock = new Clock(deadline, context.signal, controller);
  try {
    const opening = open(context.transport, {
      ...call.request,
      deadline_ms: Math.max(1, deadline - Date.now()),
      signal: controller.signal,
    });
    const opened = await clock.race(opening);
    if (opened.kind === "stopped") {
      // The Transport may still open the call. Cancel it when it does.
      opening.then(
        (late) => late.cancel(),
        () => undefined,
      );
      return stopped(opened.stop, call, []);
    }
    if (opened.kind === "failed") return transportFailure(opened.error, call, []);
    return await read(opened.value, call, clock, settings);
  } finally {
    clock.dispose();
  }
}

/** Call the Transport, so a Transport that throws before it returns a promise still rejects. */
async function open(transport: Transport, request: GrpcTransportRequest): Promise<GrpcTransportResponse> {
  return transport.grpc(request);
}

async function read(response: GrpcTransportResponse, call: Call, clock: Clock, settings: Settings): Promise<Attempt> {
  const { template } = call;
  const messages = response.messages[Symbol.asyncIterator]();
  const items: JsonValue[] = [];
  let bytes = 0;
  for (;;) {
    const next = await clock.race(messages.next());
    if (next.kind === "stopped") {
      response.cancel();
      return stopped(next.stop, call, items);
    }
    if (next.kind === "failed") {
      response.cancel();
      return transportFailure(next.error, call, items);
    }
    if (next.value.done === true) break;
    if (template.streaming === "unary" && items.length === 1) {
      response.cancel();
      return failed(internal(`${template.method} is unary, but the upstream sent more than one response message.`));
    }
    let item: JsonValue;
    try {
      item = decodeResponse(call.method, next.value.value);
    } catch (error) {
      response.cancel();
      return failed(internal(messageOf(error)));
    }
    items.push(item);
    if (template.streaming === "server") {
      bytes += Buffer.byteLength(JSON.stringify(item));
      // truncated reads true at max_items even when that message was the
      // stream's last: the Sender stops reading, so it cannot tell.
      if (items.length >= call.max_items || bytes > settings.max_stream_bytes) {
        response.cancel();
        return { ok: true, value: streamResult(items, true) };
      }
    }
  }
  const ended = await clock.race(response.status());
  if (ended.kind === "stopped") {
    response.cancel();
    return stopped(ended.stop, call, items);
  }
  if (ended.kind === "failed") return transportFailure(ended.error, call, items);
  return fromStatus(ended.value, call, items);
}

function fromStatus(status: GrpcStatus, call: Call, items: JsonValue[]): Attempt {
  if (status.code === STATUS_OK) {
    if (call.template.streaming === "server") return { ok: true, value: streamResult(items, false) };
    const [value] = items;
    if (value === undefined) {
      return failed(internal(`${call.template.method} ended with OK and sent no response message.`));
    }
    return { ok: true, value };
  }
  const name = statusName(status.code);
  const detail = status.message === "" ? `The upstream returned ${name} with no message.` : status.message;
  if (status.code === STATUS_DEADLINE_EXCEEDED) return deadlinePassed(call, items, detail);
  return failed({ title: name, detail, status: status.code }, status.code === STATUS_UNAVAILABLE && items.length === 0);
}

const TRANSPORT_TITLES: Record<Exclude<TransportErrorCode, "timeout" | "not_sent">, string> = {
  refused_address: "Address refused",
  refused_redirect: "Redirect refused",
  refused_host: "Host refused",
  unsupported: "Unsupported transport",
  disconnected: "Not connected",
};

function transportFailure(error: unknown, call: Call, items: JsonValue[]): Attempt {
  if (!(error instanceof TransportError)) {
    return failed({ title: "Transport error", detail: messageOf(error), status: undefined });
  }
  switch (error.code) {
    case "timeout":
      return deadlinePassed(call, items, error.message);
    case "not_sent":
      // The call never left, which gRPC reports as UNAVAILABLE.
      return failed(
        { title: statusName(STATUS_UNAVAILABLE), detail: error.message, status: STATUS_UNAVAILABLE },
        items.length === 0,
      );
    default:
      return failed({ title: TRANSPORT_TITLES[error.code], detail: error.message, status: undefined });
  }
}

function stopped(stop: Stop, call: Call, items: JsonValue[]): Attempt {
  if (stop === "cancelled") return failed(CANCELLED);
  return deadlinePassed(call, items, `The call passed its deadline of ${call.deadline_ms} ms.`);
}

/** A stream returns what it read by the deadline. A unary call has nothing to return. */
function deadlinePassed(call: Call, items: JsonValue[], detail: string): Attempt {
  if (call.template.streaming === "server") return { ok: true, value: streamResult(items, true) };
  return failed({ title: statusName(STATUS_DEADLINE_EXCEEDED), detail, status: STATUS_DEADLINE_EXCEEDED });
}

function streamResult(items: JsonValue[], truncated: boolean): GrpcStreamResult {
  return { items, truncated };
}

function internal(detail: string): SendError {
  return { title: statusName(STATUS_INTERNAL), detail, status: STATUS_INTERNAL };
}

function failed(error: SendError, retryable = false): Attempt {
  return { ok: false, error, retryable };
}

/** Wait, or resolve false as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type Stop = "deadline" | "cancelled";
type Raced<T> = { kind: "value"; value: T } | { kind: "failed"; error: unknown } | { kind: "stopped"; stop: Stop };

/**
 * The deadline and the caller's signal for one attempt.
 *
 * race() settles with the promise's result, or with the stop that comes
 * first. The clock holds one waiter at a time, so a long stream does not
 * pile up a listener per message. A stop also aborts the attempt's signal,
 * which tells the Transport to cancel the call.
 */
class Clock {
  private stop: Stop | undefined;
  private waiter: ((stop: Stop) => void) | undefined;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private readonly onAbort = (): void => this.fire("cancelled");

  constructor(deadline: number, signal: AbortSignal, controller: AbortController) {
    this.signal = signal;
    this.controller = controller;
    this.timer = setTimeout(() => this.fire("deadline"), Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_MS));
    if (signal.aborted) this.fire("cancelled");
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }

  race<T>(promise: Promise<T>): Promise<Raced<T>> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: Raced<T>): void => {
        if (settled) return;
        settled = true;
        this.waiter = undefined;
        resolve(result);
      };
      promise.then(
        (value) => settle({ kind: "value", value }),
        (error: unknown) => settle({ kind: "failed", error }),
      );
      if (this.stop === undefined) this.waiter = (stop) => settle({ kind: "stopped", stop });
      else settle({ kind: "stopped", stop: this.stop });
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.onAbort);
  }

  private fire(stop: Stop): void {
    if (this.stop !== undefined) return;
    this.stop = stop;
    this.controller.abort();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(stop);
  }
}
