/**
 * A one-shot JSON-RPC client for `codex app-server`, the stdio control
 * channel the Codex CLI exposes for its own GUI. Tacho needs exactly two of
 * its methods — `hooks/list` and `config/value/write` — and uses them for one
 * job: making the hooks Tacho installs trusted (see `codex-hook-trust.ts`).
 *
 * Two facts about the transport shape this module:
 *
 *   - `app-server` exits as soon as its stdin reaches EOF, before it answers
 *     anything still in flight. A `spawnSync` with `input` therefore returns
 *     the `initialize` reply and nothing else, so the client is asynchronous
 *     and holds stdin open until every id it sent has come back.
 *   - `initialize` must be the first request; the server answers later
 *     methods only after it and the initialized notification. Requests run
 *     sequentially so a trust read cannot overtake its preceding write.
 *
 * Everything is best effort. A Codex too old to know a method answers with a
 * JSON-RPC error, a Codex that is not on PATH fails to spawn, and either way
 * the caller reports a warning rather than failing the command it is part of.
 */
import { spawn } from "node:child_process";

export interface CodexRpcRequest {
  method: string;
  params?: unknown;
}

export interface CodexRpcError {
  code?: number;
  message?: string;
}

/** One answer, in the order its request was sent. */
export interface CodexRpcAnswer {
  result?: unknown;
  error?: CodexRpcError;
}

export interface CodexAppServerResult {
  /** One entry per request, excluding the handshake. */
  answers: CodexRpcAnswer[];
  /** Why nothing could be asked at all: spawn failed, or the deadline hit. */
  problem?: string;
}

/** Drive `codex app-server` for one exchange; never throws. */
export type CodexAppServer = (
  requests: readonly CodexRpcRequest[],
) => Promise<CodexAppServerResult>;

export interface CodexAppServerOptions {
  /** The `codex` executable, as `harnessFacts` found it. */
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The whole exchange's budget. The server is local and answers in ms. */
  timeoutMs?: number;
  /** What `initialize` reports as the client, for Codex's own telemetry. */
  clientName?: string;
  clientVersion?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function failure(problem: string, count: number): CodexAppServerResult {
  return { answers: Array.from({ length: count }, () => ({})), problem };
}

export function codexAppServerClient(
  options: CodexAppServerOptions,
): CodexAppServer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (requests) =>
    new Promise<CodexAppServerResult>((resolve) => {
      if (requests.length === 0) {
        resolve({ answers: [] });
        return;
      }
      let child;
      try {
        child = spawn(options.binary, ["app-server"], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch (error) {
        resolve(
          failure(
            `could not run \`codex app-server\`: ${error instanceof Error ? error.message : String(error)}`,
            requests.length,
          ),
        );
        return;
      }

      // Request 0 is the handshake; the caller's requests are 1..n, so an id
      // doubles as the index into `answers`.
      const answers: CodexRpcAnswer[] = Array.from(
        { length: requests.length },
        () => ({}),
      );
      const outstanding = new Set(requests.map((_, index) => index + 1));
      let settled = false;
      let buffer = "";
      let nextRequest = 0;
      let initialized = false;

      const finish = (problem?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve(problem === undefined ? { answers } : { answers, problem });
      };

      const timer = setTimeout(
        () => finish("`codex app-server` did not answer in time"),
        timeoutMs,
      );

      child.on("error", (error) =>
        finish(`could not run \`codex app-server\`: ${error.message}`),
      );
      // A server that exits before answering leaves `answers` as it is; the
      // caller reads an empty answer the same way it reads an error one.
      child.on("close", () => finish());

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.trim().length === 0) continue;
          let message: { id?: unknown; result?: unknown; error?: unknown };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            // Notifications and log lines share the stream; skip what is not
            // an answer rather than giving up on the exchange.
            continue;
          }
          if (typeof message.id !== "number") continue;
          if (message.id === 0) {
            if (initialized) continue;
            if (message.error !== undefined || message.result === undefined) {
              finish("`codex app-server` refused initialization");
              return;
            }
            initialized = true;
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
            );
            sendNext();
            continue;
          }
          const index = message.id - 1;
          if (
            index < 0 ||
            index >= answers.length ||
            !outstanding.has(message.id) ||
            message.id !== nextRequest
          )
            continue;
          answers[index] =
            message.error !== undefined
              ? { error: message.error as CodexRpcError }
              : { result: message.result };
          outstanding.delete(message.id);
          if (outstanding.size === 0) finish();
          else sendNext();
        }
      });

      const send = (id: number, request: CodexRpcRequest): void => {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, ...request })}\n`,
        );
      };
      const sendNext = (): void => {
        const request = requests[nextRequest];
        if (settled || request === undefined) return;
        nextRequest += 1;
        send(nextRequest, request);
      };
      child.stdin.on("error", () =>
        finish("`codex app-server` closed its input"),
      );
      send(0, {
        method: "initialize",
        params: {
          clientInfo: {
            name: options.clientName ?? "tacho",
            version: options.clientVersion ?? "0",
          },
        },
      });
    });
}
