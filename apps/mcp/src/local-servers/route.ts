// route.ts: the two routes an enrolled machine polls for local tool calls
// (mcp-studio-spec, Local servers; #4773).
//
// GET /v1/local-servers/next holds the request until a call for the machine
// arrives or the broker's wait ends. It answers 200 with the delivery, or
// 204 with nothing. POST /v1/local-servers/replies takes the machine's answer
// to a delivery and answers 204. The paths are the ones tacho's cloud link
// dials, read from tacho through the broker module so the two cannot drift.
// Every other request passes through untouched.
import {
  LOCAL_SERVERS_NEXT_PATH,
  LOCAL_SERVERS_REPLY_PATH,
  type LocalGatewayBroker,
} from "@oxagen/handlers/mcp-studio/local-calls/broker";
import type { ServedHeaders, ServedNext, ServedResponse } from "../servers/middleware";
import type { MachineAuthResult } from "./auth";

/** The fields of an express request the route reads. */
export interface LocalServersRequest {
  method?: string;
  path?: string;
  url?: string;
  body?: unknown;
  headers: ServedHeaders;
}

/** The fields of a node response the route writes, plus its close event. */
export interface LocalServersResponse extends ServedResponse {
  on(event: "close", listener: () => void): unknown;
  readonly writableEnded?: boolean;
}

export type LocalServersMiddleware = (req: LocalServersRequest, res: LocalServersResponse, next: ServedNext) => void;

export interface LocalServersRouteDeps {
  authenticate(headers: ServedHeaders): Promise<MachineAuthResult>;
  broker(): LocalGatewayBroker;
  /** How long a poll waits for a call. The broker's own wait when unset. */
  waitMs?: number;
  log?(event: string, fields: Record<string, unknown>): void;
}

function pathOf(req: LocalServersRequest): string {
  const raw = req.path ?? req.url ?? "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

function send(res: LocalServersResponse, status: number, body?: unknown): void {
  if (res.writableEnded === true) return;
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function servePoll(
  machine: string,
  res: LocalServersResponse,
  deps: LocalServersRouteDeps,
): Promise<void> {
  // A machine that hangs up stops waiting in the broker, so a call that
  // arrives next is not handed to a request nobody reads.
  const hangup = new AbortController();
  res.on("close", () => hangup.abort());
  const delivery = await deps.broker().next(machine, hangup.signal, deps.waitMs);
  if (hangup.signal.aborted) return;
  if (delivery === undefined) send(res, 204);
  else send(res, 200, delivery);
}

function serveReply(machine: string, body: unknown, res: LocalServersResponse, deps: LocalServersRouteDeps): void {
  const outcome = deps.broker().reply(machine, body);
  if (outcome.accepted) {
    send(res, 204);
    return;
  }
  deps.log?.("local_servers.reply_refused", { machine, reason: outcome.reason });
  const status = outcome.reason === "invalid" ? 400 : 409;
  const messages: Record<typeof outcome.reason, string> = {
    invalid: "The reply does not match the local-server reply shape.",
    wrong_machine: "The reply names another machine than the key's.",
    unknown_id: "No call waits for this reply. It timed out, was answered, or was never sent to this machine.",
    wrong_kind: "The reply's kind does not answer the delivery it names.",
  };
  send(res, status, {
    error: { code: status === 400 ? "bad_request" : "conflict", reason: outcome.reason, message: messages[outcome.reason] },
  });
}

/** Serves a machine's long-poll and its replies from this process's broker. */
export function createLocalServersRoute(deps: LocalServersRouteDeps): LocalServersMiddleware {
  return (req, res, next) => {
    const path = pathOf(req);
    const poll = path === LOCAL_SERVERS_NEXT_PATH;
    const reply = path === LOCAL_SERVERS_REPLY_PATH;
    if (!poll && !reply) {
      next();
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if ((poll && method !== "GET") || (reply && method !== "POST")) {
      res.setHeader("allow", poll ? "GET" : "POST");
      send(res, 405, { error: { code: "method_not_allowed", message: `Use ${poll ? "GET" : "POST"} on ${path}.` } });
      return;
    }
    void (async () => {
      const auth = await deps.authenticate(req.headers);
      if (!auth.ok) {
        send(res, auth.status, auth.body);
        return;
      }
      if (poll) await servePoll(auth.machine, res, deps);
      else serveReply(auth.machine, req.body, res, deps);
    })().catch((error: unknown) => {
      deps.log?.("local_servers.route_failed", { path, error: error instanceof Error ? error.message : String(error) });
      send(res, 500, { error: { code: "internal_error", message: "The local-server route failed. The machine retries." } });
    });
  };
}
