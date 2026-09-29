// connection.ts: the relay's one outbound connection to the Oxagen broker.
//
// The relay dials out, sends hello, and waits for welcome. Once welcomed, it
// sends a heartbeat at the interval the broker named and closes the
// connection when the broker goes silent for three intervals. When the
// connection closes, it reconnects after a backoff that doubles up to 30
// seconds, with jitter.
//
// The relay fails closed. It sends a request upstream only when a request
// frame arrives on a live connection and passes every check in verify.ts.
// When the connection closes, every call in flight is stopped, so nothing
// reaches an upstream while the relay is disconnected.
import {
  CLOSE_TOKEN_REVOKED,
  decodeBrokerFrame,
  DEFAULT_MISSED_HEARTBEATS,
  encodeFrame,
  MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  type RelayFrame,
} from "@oxagen/relay-broker/protocol";
import { WebSocket, type RawData } from "ws";
import type { RelayConfig } from "./config";
import { logPath, type RelayLog } from "./log";
import { NonceCache } from "./nonces";
import { clip, FrameSink } from "./sink";
import { createUpstreams, type Upstreams } from "./upstream";
import { messageOf } from "./upstream/types";
import { verifyRequest, type RequestFrame } from "./verify";

/** The most calls the relay carries at once. The broker gets busy for more. */
export const MAX_CONCURRENT_CALLS = 256;
/** How long the relay waits for the broker's welcome after it dials. */
export const DEFAULT_WELCOME_TIMEOUT_MS = 10_000;
export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** How long stop() waits for the broker to answer the close before it drops the connection. */
export const STOP_GRACE_MS = 2_000;
/** WebSocket close code 1002: the peer broke the protocol. */
const CLOSE_PROTOCOL_ERROR = 1002;
const MAX_REFUSAL_MESSAGE = 2048;
const MAX_VERSION_LENGTH = 64;

/**
 * - starting: waiting out the start delay before the first dial.
 * - connecting: dialled, and waiting for the broker's welcome.
 * - ready: welcomed. Requests may arrive.
 * - waiting: disconnected, and waiting out the backoff before the next dial.
 * - stopped: stop() finished. The relay never dials again.
 */
export type RelayState = "starting" | "connecting" | "ready" | "waiting" | "stopped";

export interface BackoffSettings {
  initialMs: number;
  maxMs: number;
}

export interface StartRelayOptions {
  config: RelayConfig;
  /** The relay's version, sent in hello. */
  version: string;
  now?: () => number;
  /** A number in [0, 1) for the backoff jitter. */
  random?: () => number;
  log?: RelayLog;
  upstreams?: Upstreams;
  backoff?: BackoffSettings;
  welcomeTimeoutMs?: number;
  /**
   * How long to wait before the first dial. The default is twice the clock
   * skew, so that every envelope the broker signs after the relay connects
   * passes the check that it was issued after this process started.
   */
  startDelayMs?: number;
  nonces?: NonceCache;
  onState?: (state: RelayState) => void;
}

export interface RelayHandle {
  readonly state: RelayState;
  /** Close the connection, stop every call, and never dial again. */
  stop(): Promise<void>;
}

/** The wait before reconnect attempt `attempt`, counted from 0. */
export function backoffDelay(attempt: number, settings: BackoffSettings, random: () => number): number {
  const ceiling = Math.min(settings.maxMs, settings.initialMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

interface LiveCall {
  sink: FrameSink;
}

/** Start the relay. It keeps one connection to the broker until stop() is called. */
export function startRelay(options: StartRelayOptions): RelayHandle {
  const { config } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log: RelayLog = options.log ?? (() => undefined);
  const upstreams = options.upstreams ?? createUpstreams({ maxResponseBytes: config.maxResponseBytes });
  const backoff = options.backoff ?? { initialMs: BACKOFF_INITIAL_MS, maxMs: BACKOFF_MAX_MS };
  const welcomeTimeoutMs = options.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS;
  const nonces = options.nonces ?? new NonceCache();
  const version = clip(options.version, MAX_VERSION_LENGTH);
  const startedAt = now();

  let state: RelayState = "starting";
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | undefined;
  let dialTimer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;

  const setState = (next: RelayState): void => {
    if (state === next) return;
    state = next;
    options.onState?.(next);
  };

  const scheduleDial = (delayMs: number): void => {
    dialTimer = setTimeout(() => {
      dialTimer = undefined;
      connect();
    }, delayMs);
  };

  function connect(): void {
    if (stopped) return;
    setState("connecting");
    const ws = new WebSocket(config.brokerUrl, {
      headers: { authorization: `Bearer ${config.token}` },
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: welcomeTimeoutMs,
    });
    socket = ws;
    const calls = new Map<string, LiveCall>();
    let welcomed = false;
    let lastSeen = now();
    let heartbeat: NodeJS.Timeout | undefined;
    const welcomeTimer = setTimeout(() => {
      log("welcome_timeout", { waited_ms: welcomeTimeoutMs });
      ws.terminate();
    }, welcomeTimeoutMs);

    const send = (frame: RelayFrame): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame));
    };
    const protocolError = (reason: string): void => {
      log("protocol_error", { reason });
      ws.close(CLOSE_PROTOCOL_ERROR, reason);
    };

    const handleRequest = (frame: RequestFrame): void => {
      const { id } = frame;
      if (calls.has(id)) {
        // A refusal would name the call already in flight, so the frame is dropped.
        log("duplicate_call", { id });
        return;
      }
      if (calls.size >= MAX_CONCURRENT_CALLS) {
        send({ type: "refused", id, code: "busy", message: `The relay is carrying ${MAX_CONCURRENT_CALLS} calls, its most at once.` });
        log("refused", { id, code: "busy" });
        return;
      }
      const verdict = verifyRequest(frame, { config, nonces, startedAt, now: now() });
      if (!verdict.ok) {
        send({ type: "refused", id, code: verdict.code, message: clip(verdict.message, MAX_REFUSAL_MESSAGE) });
        log("refused", { id, code: verdict.code });
        return;
      }

      const controller = new AbortController();
      const began = now();
      const sink = new FrameSink({
        id,
        send,
        buffered: () => ws.bufferedAmount,
        maxResponseBytes: config.maxResponseBytes,
        onDone: () => {
          calls.delete(id);
          controller.abort();
          log("call_done", { id, ms: now() - began });
        },
      });
      calls.set(id, { sink });

      const { target } = verdict.envelope;
      const call = {
        headers: verdict.headers,
        body: verdict.body,
        deadlineMs: verdict.deadlineMs,
        ...(verdict.clientCert === undefined ? {} : { clientCert: verdict.clientCert }),
        signal: controller.signal,
        sink,
      };
      try {
        if (target.kind === "http") {
          // The log names the call, never a header, a body, or a query string.
          log("call", { id, kind: "http", host: target.host, method: target.method, path: logPath(target.path) });
          upstreams.http({ ...call, target });
        } else {
          log("call", { id, kind: "grpc", host: target.host, service: target.service, method: target.method });
          upstreams.grpc({ ...call, target });
        }
      } catch (error) {
        sink.fail("upstream", `The relay could not start the call: ${messageOf(error)}`, false);
      }
    };

    const beat = (heartbeatMs: number): void => {
      if (now() - lastSeen > heartbeatMs * DEFAULT_MISSED_HEARTBEATS) {
        log("heartbeat_missed", { silent_ms: now() - lastSeen });
        ws.terminate();
        return;
      }
      send({ type: "hb" });
    };

    ws.on("open", () => {
      lastSeen = now();
      send({ type: "hello", protocol: RELAY_PROTOCOL_VERSION, relay: config.relay, workspace: config.workspace, version });
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      lastSeen = now();
      const frame = isBinary ? undefined : decodeBrokerFrame(rawText(data));
      if (frame === undefined) {
        protocolError("The broker sent a frame the relay cannot read.");
        return;
      }
      if (!welcomed) {
        if (frame.type !== "welcome") {
          protocolError("The broker sent a frame before its welcome.");
          return;
        }
        welcomed = true;
        clearTimeout(welcomeTimer);
        attempt = 0;
        heartbeat = setInterval(() => beat(frame.heartbeat_ms), frame.heartbeat_ms);
        setState("ready");
        log("ready", { heartbeat_ms: frame.heartbeat_ms });
        return;
      }
      switch (frame.type) {
        case "welcome":
          protocolError("The broker sent a second welcome.");
          return;
        case "hb_ack":
          return;
        case "cancel":
          // Closing the sink stops the upstream and sends nothing more.
          calls.get(frame.id)?.sink.close();
          return;
        case "request":
          handleRequest(frame);
          return;
      }
    });

    ws.on("error", (error: Error) => {
      // A close always follows. The message holds no token: ws reports the
      // HTTP status or the network error.
      log("connection_error", { message: error.message });
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(welcomeTimer);
      clearInterval(heartbeat);
      // Fail closed: with the connection gone, no call may keep running.
      const open = [...calls.values()];
      for (const call of open) call.sink.close();
      if (socket === ws) socket = undefined;
      log("disconnected", { code, reason: clip(reason.toString("utf8"), 200), calls_stopped: open.length });
      if (code === CLOSE_TOKEN_REVOKED) {
        // The relay keeps dialing, and the broker answers each dial with 401
        // until an operator restarts the relay with a new token.
        log("token_revoked", {
          message: "Oxagen revoked this relay's token. Mint a new relay token and restart the relay with it.",
        });
      }
      if (stopped) return;
      const delay = backoffDelay(attempt, backoff, random);
      attempt += 1;
      setState("waiting");
      log("reconnecting", { in_ms: delay, attempt });
      scheduleDial(delay);
    });
  }

  const stop = (): Promise<void> => {
    if (stopping !== undefined) return stopping;
    stopped = true;
    clearTimeout(dialTimer);
    const current = socket;
    stopping = new Promise<void>((resolve) => {
      const finish = (): void => {
        upstreams.close();
        setState("stopped");
        log("stopped");
        resolve();
      };
      if (current === undefined || current.readyState === WebSocket.CLOSED) {
        finish();
        return;
      }
      const force = setTimeout(() => current.terminate(), STOP_GRACE_MS);
      current.once("close", () => {
        clearTimeout(force);
        finish();
      });
      current.close(1000, "The relay is stopping.");
    });
    return stopping;
  };

  const startDelayMs = options.startDelayMs ?? 2 * config.clockSkewMs;
  log("starting", { relay: config.relay, workspace: config.workspace, version, first_dial_in_ms: startDelayMs });
  scheduleDial(startDelayMs);

  return {
    get state() {
      return state;
    },
    stop,
  };
}
