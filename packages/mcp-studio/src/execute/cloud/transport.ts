// transport.ts: the cloud Transport (mcp-studio-spec, Network paths).
//
// It carries a call on the cloud network straight from Oxagen to the
// upstream: HTTP over node:http and node:https, and gRPC through lane M7's
// carrier. Before it connects, it resolves the host and refuses the call
// when the host is, or resolves to, an address that is not public. It then
// dials the address it checked, and names the host in the Host header and in
// TLS, so the certificate is checked against the host and not the address.
//
// It never follows a redirect: the Sender receives the 3xx and refuses it.
// One deadline covers the lookup, the request, and the whole body. A relay
// network and a local server are other Transports, so this one refuses them
// as "unsupported".
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createGrpcCarrier } from "../grpc/carrier";
import {
  TransportError,
  type HeaderEntry,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type Transport,
} from "../transport";
import { messageOf } from "../util";
import { resolvePublicAddress, unlessAborted } from "./address";

export interface CloudTransportOptions {
  /**
   * The address to dial for a host, or a TransportError such as
   * refused_address. resolvePublicAddress by default. A test passes one
   * that allows its loopback server.
   */
  resolve?: (host: string, signal: AbortSignal) => Promise<string>;
  /** PEM root certificates to trust in place of the system's. */
  root_certs?: Uint8Array;
}

interface Settings {
  resolve: (host: string, signal: AbortSignal) => Promise<string>;
  ca: Buffer | undefined;
  http: HttpAgent;
  https: HttpsAgent;
}

/** A Transport for the cloud network. */
export function createCloudTransport(options: CloudTransportOptions = {}): Transport {
  const settings: Settings = {
    resolve: options.resolve ?? ((host, signal) => resolvePublicAddress(host, signal)),
    ca: options.root_certs === undefined ? undefined : Buffer.from(options.root_certs),
    // The transport keeps its connections open between calls. An idle one
    // closes after 5 seconds, as Node's own agents do, before a server's
    // keep-alive timeout closes it under a new request.
    http: new HttpAgent({ keepAlive: true, timeout: 5_000 }),
    https: new HttpsAgent({ keepAlive: true, timeout: 5_000 }),
  };
  const carrier = createGrpcCarrier({ resolve: settings.resolve, root_certs: options.root_certs });
  return {
    http: (request) => sendHttp(request, settings),
    grpc: (request) => {
      const refused = routeRefusal(request);
      return refused === undefined ? carrier.grpc(request) : Promise.reject(refused);
    },
    local: () =>
      Promise.reject(
        new TransportError(
          "unsupported",
          "The cloud Transport does not reach local servers. A local server's calls go through the local gateway.",
          false,
        ),
      ),
  };
}

/** Why this Transport cannot carry a request, or undefined when it can. */
function routeRefusal(request: Pick<HttpTransportRequest, "network" | "relay_credential">): TransportError | undefined {
  if (request.network !== "cloud") {
    return new TransportError(
      "unsupported",
      `The cloud Transport sends on the cloud network only, and this call is for ${request.network}.`,
      false,
    );
  }
  if (request.relay_credential !== undefined) {
    return new TransportError("unsupported", "The cloud Transport cannot add a relay credential. Only a relay adds one.", false);
  }
  return undefined;
}

/** A lookup that answers every host with the address already checked. */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_host, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** The headers as Node takes them: one list of values per lowercase name. */
function headerRecord(entries: readonly HeaderEntry[]): Record<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    const values = byName.get(key);
    if (values === undefined) byName.set(key, [value]);
    else values.push(value);
  }
  // fromEntries defines each name as an own property, so no header name
  // can reach the object's prototype.
  return Object.fromEntries(byName);
}

/** The response's headers in the order they arrived, with repeated names kept. */
function headerEntries(raw: readonly string[]): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    entries.push(raw.slice(index, index + 2) as [string, string]);
  }
  return entries;
}

/**
 * The body as it arrives. A connection that closes early is an error, not a
 * short body. A deadline or a cancel that stopped the read is its own error.
 */
async function* bodyOf(
  response: IncomingMessage,
  host: string,
  stoppedBy: () => Error | undefined,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of response as AsyncIterable<Buffer>) yield chunk;
  } catch (error) {
    throw stoppedBy() ?? new Error(`The connection to ${host} closed before the response ended: ${messageOf(error)}`);
  }
}

/** Runs the listener when the signal aborts, or now when it already has. */
function whenAborted(signal: AbortSignal, listener: () => void): void {
  if (signal.aborted) listener();
  else signal.addEventListener("abort", listener, { once: true });
}

function deadlineError(deadline_ms: number, sent: boolean): TransportError {
  return sent
    ? new TransportError("timeout", `The call passed its ${deadline_ms} ms deadline.`, true)
    : new TransportError("timeout", `The call passed its ${deadline_ms} ms deadline before it was sent.`, false);
}

function cancelError(sent: boolean): Error {
  // TransportError has no code for a cancel after the send. Any other error
  // tells the Sender the upstream may have received the request.
  return sent
    ? new Error("The call was cancelled after it was sent.")
    : new TransportError("not_sent", "The call was cancelled before it was sent.", false);
}

/**
 * A connection failure. Before the request left, the upstream cannot have
 * received it. After, TransportError has no code for it, and any other error
 * tells the Sender the upstream may have received the request.
 */
function connectionError(error: unknown, host: string, sent: boolean): Error {
  if (!sent) return new TransportError("not_sent", `The connection to ${host} failed: ${messageOf(error)}`, false);
  return new Error(`The connection to ${host} failed after the request was sent: ${messageOf(error)}`);
}

async function sendHttp(request: HttpTransportRequest, settings: Settings): Promise<HttpTransportResponse> {
  const refused = routeRefusal(request);
  if (refused !== undefined) throw refused;
  const { target, deadline_ms, signal } = request;
  const tls = target.scheme === "https";

  // The request counts as sent once its bytes can reach the upstream: when
  // the connection opens, or when TLS finishes its handshake.
  let sent = false;
  // The first deadline or cancel stops the call. Its error is the stop
  // signal's reason, and a later abort changes nothing.
  const stop = new AbortController();
  const stoppedBy = (): Error | undefined => stop.signal.reason as Error | undefined;
  const timer = setTimeout(() => stop.abort(deadlineError(deadline_ms, sent)), deadline_ms);
  timer.unref();
  const onCancel = (): void => stop.abort(cancelError(sent));
  whenAborted(signal, onCancel);
  const release = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCancel);
  };

  let address: string;
  try {
    address = await unlessAborted(settings.resolve(target.host, stop.signal), stop.signal);
  } catch (error) {
    release();
    if (error instanceof TransportError) throw error;
    throw new TransportError("not_sent", `${target.host} did not resolve: ${messageOf(error)}`, false);
  }

  const options: HttpsRequestOptions = {
    hostname: target.host,
    // Undefined takes the agent's default port, 443 or 80, and leaves the
    // port out of the Host header.
    port: target.port,
    method: target.method,
    path: target.path,
    headers: headerRecord(request.headers),
    agent: tls ? settings.https : settings.http,
    lookup: pinnedLookup(address),
  };
  if (tls && settings.ca !== undefined) options.ca = settings.ca;

  return new Promise<HttpTransportResponse>((resolve, reject) => {
    let outgoing: ClientRequest;
    try {
      outgoing = tls ? httpsRequest(options) : httpRequest(options);
    } catch (error) {
      // Node refuses a bad method, path, or header before it connects. Its
      // message names the part, never a header's value.
      release();
      reject(new TransportError("not_sent", `The request is not valid: ${messageOf(error)}`, false));
      return;
    }
    let incoming: IncomingMessage | undefined;
    const onStop = (): void => {
      if (incoming === undefined) outgoing.destroy(stoppedBy());
      else incoming.destroy(stoppedBy());
    };
    whenAborted(stop.signal, onStop);

    outgoing.once("socket", (socket) => {
      if (!socket.connecting) {
        // A kept-alive connection is already open.
        sent = true;
        return;
      }
      socket.once(tls ? "secureConnect" : "connect", () => {
        sent = true;
      });
    });
    // The listener stays for the request's life, so a late socket error
    // cannot go unhandled. A promise settles once, so only the first counts.
    // A deadline or a cancel destroys the request with its own error.
    outgoing.on("error", (error) => {
      release();
      reject(stoppedBy() ?? connectionError(error, target.host, sent));
    });
    outgoing.once("response", (response) => {
      incoming = response;
      // The body's reader reports an error when it reads. This listener only
      // keeps an error before the first read from going unhandled.
      response.on("error", () => undefined);
      response.once("close", release);
      resolve({
        // A client response always carries a status code.
        status: Number(response.statusCode),
        headers: headerEntries(response.rawHeaders),
        body: bodyOf(response, target.host, stoppedBy),
        cancel: () => {
          release();
          response.destroy();
        },
      });
    });
    if (request.body.byteLength === 0) outgoing.end();
    else outgoing.end(request.body);
  });
}
