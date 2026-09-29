// http.ts: send one HTTP/1.1 request upstream and stream the response back.
//
// The relay sends exactly the method, host, port, and path the envelope names,
// with the signed headers and body. It never follows a redirect: a 3xx goes
// back to Oxagen like any other response. One deadline, the envelope's
// deadline_ms, covers the connection, the request, and the whole body. MCP
// streamable HTTP is plain HTTP here, and its event stream flows back in parts
// as it arrives. A mutual_tls credential gets its own keep-alive agent, so a
// connection opened with one client certificate never carries a call made
// with another.
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { createSecureContext } from "node:tls";
import { DATA_CHUNK_BYTES } from "@oxagen/relay-broker/protocol";
import type { ClientCertificate, HeaderEntry } from "../credentials";
import type { ResponseSink } from "../sink";
import { messageOf, type RelayHttpTarget, type UpstreamCall } from "./types";

export interface HttpUpstream {
  send(call: UpstreamCall<RelayHttpTarget>): void;
  close(): void;
}

export interface Agents {
  http: HttpAgent;
  https: HttpsAgent;
  /** One agent per mutual_tls credential, keyed by the credential's name. */
  mutual: Map<string, HttpsAgent>;
}

// An idle connection closes after 5 seconds, as Node's own agents do, before
// a server's keep-alive timeout closes it under a new request.
const AGENT_OPTIONS = { keepAlive: true, timeout: 5_000 } as const;

/** The agents one HTTP sender shares across its calls. */
export function createHttpAgents(): Agents {
  return { http: new HttpAgent(AGENT_OPTIONS), https: new HttpsAgent(AGENT_OPTIONS), mutual: new Map() };
}

/**
 * The agent for one call. A call with a client certificate gets the agent for
 * its credential, made on first use. Throws when the certificate or key does
 * not load, before any connection opens.
 */
export function agentFor(agents: Agents, tls: boolean, clientCert?: ClientCertificate): HttpAgent {
  if (!tls) return agents.http;
  if (clientCert === undefined) return agents.https;
  const existing = agents.mutual.get(clientCert.name);
  if (existing !== undefined) return existing;
  // The agent loads the pair only when it opens a connection. Loading it here
  // turns a bad pair into a refusal before anything is sent.
  createSecureContext({ cert: clientCert.cert, key: clientCert.key });
  const agent = new HttpsAgent({ ...AGENT_OPTIONS, cert: clientCert.cert, key: clientCert.key });
  agents.mutual.set(clientCert.name, agent);
  return agent;
}

/** Close every agent's connections and forget the per-credential agents. */
export function destroyAgents(agents: Agents): void {
  agents.http.destroy();
  agents.https.destroy();
  for (const agent of agents.mutual.values()) agent.destroy();
  agents.mutual.clear();
}

/** An HTTP sender that keeps connections open between calls. */
export function createHttpUpstream(): HttpUpstream {
  const agents = createHttpAgents();
  return {
    send: (call) => sendHttp(call, agents),
    close: () => destroyAgents(agents),
  };
}

/** The headers as Node takes them: one list of values per lowercase name. */
function headerRecord(entries: readonly HeaderEntry[]): OutgoingHttpHeaders {
  const byName = new Map<string, string[]>();
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    const values = byName.get(key);
    if (values === undefined) byName.set(key, [value]);
    else values.push(value);
  }
  // fromEntries defines each name as an own property, so no header name can
  // reach the object's prototype.
  return Object.fromEntries(byName);
}

/** The response's headers in the order they arrived, with repeated names kept. */
function headerEntries(raw: readonly string[]): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    entries.push([raw[index] ?? "", raw[index + 1] ?? ""]);
  }
  return entries;
}

/** Copy the body to the sink in parts. False when the sink ended the call first. */
async function pump(response: IncomingMessage, sink: ResponseSink): Promise<boolean> {
  for await (const chunk of response as AsyncIterable<Buffer>) {
    for (let offset = 0; offset < chunk.byteLength; offset += DATA_CHUNK_BYTES) {
      if (!(await sink.data(chunk.subarray(offset, offset + DATA_CHUNK_BYTES)))) return false;
    }
  }
  return true;
}

function sendHttp(call: UpstreamCall<RelayHttpTarget>, agents: Agents): void {
  const { target, sink, signal, deadlineMs, clientCert } = call;
  if (signal.aborted) return;
  const tls = target.scheme === "https";

  // The envelope schema already refuses a mutual_tls credential on an http
  // target. This check keeps a certificate from being dropped in silence if
  // that ever changes.
  if (clientCert !== undefined && !tls) {
    sink.fail("upstream", `Credential ${clientCert.name} presents a client certificate, which needs an https target.`, false);
    return;
  }
  let agent: HttpAgent;
  try {
    agent = agentFor(agents, tls, clientCert);
  } catch {
    // OpenSSL's message can quote the input, so the relay names the credential only.
    sink.fail("upstream", `The relay could not load the client certificate for credential ${clientCert?.name ?? ""}.`, false);
    return;
  }

  // The request counts as sent once its bytes can reach the upstream: when
  // the connection opens, or when TLS finishes its handshake.
  let sent = false;
  let outgoing: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  const stop = (): void => {
    incoming?.destroy();
    outgoing?.destroy();
  };
  const timer = setTimeout(() => {
    sink.fail("timeout", `${target.host} did not finish within the envelope's ${deadlineMs} ms deadline.`, sent);
    stop();
  }, deadlineMs);
  // The broker cancelled, the connection closed, or the sink ended the call.
  // In each case the sink already knows, so only the upstream needs stopping.
  const onAbort = (): void => stop();
  signal.addEventListener("abort", onAbort, { once: true });
  const release = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  };

  const options: RequestOptions = {
    hostname: target.host,
    // Undefined takes the agent's default port, 443 or 80, and leaves the
    // port out of the Host header.
    port: target.port,
    method: target.method,
    path: target.path,
    headers: headerRecord(call.headers),
    agent,
  };
  try {
    outgoing = tls ? httpsRequest(options) : httpRequest(options);
  } catch (error) {
    // Node refuses a bad method, path, or header before it connects. Its
    // message names the part, never a header's value.
    release();
    sink.fail("upstream", `The request is not valid: ${messageOf(error)}`, false);
    return;
  }

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
  // The listener stays for the request's life, so a late socket error cannot
  // go unhandled. The sink sends only the first terminal frame.
  outgoing.on("error", (error) => {
    release();
    sink.fail("upstream", `The connection to ${target.host} failed: ${messageOf(error)}`, sent);
  });
  outgoing.once("response", (response) => {
    incoming = response;
    // pump reports a read error. This listener only keeps an error before the
    // first read from going unhandled.
    response.on("error", () => undefined);
    sink.head(Number(response.statusCode), headerEntries(response.rawHeaders));
    pump(response, sink).then(
      (finished) => {
        release();
        if (finished) sink.end();
        else response.destroy();
      },
      (error: unknown) => {
        release();
        sink.fail("upstream", `The connection to ${target.host} closed before the response ended: ${messageOf(error)}`, true);
      },
    );
  });
  if (call.body.byteLength === 0) outgoing.end();
  else outgoing.end(call.body);
}
