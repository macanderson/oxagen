/**
 * `tacho mcp-stdio`: the stdio shim for a connected app that cannot dial a
 * URL (ADR-078).
 *
 * Claude Desktop's `claude_desktop_config.json` takes `command` / `args` /
 * `env` and nothing else — no `type`, no `url`. Remote servers are added
 * through Settings → Connectors in the app, which no third party can write
 * to. (Verified 2026-09-16 against the MCP quickstart,
 * https://modelcontextprotocol.io/quickstart/user, and Anthropic's separate
 * "Connect to remote MCP Servers" page, which describes a UI-only flow.) So a
 * stdio entrypoint is not a convenience here; it is the only way in.
 *
 * It duplicates nothing. The shim reads newline-delimited JSON-RPC on stdin,
 * POSTs each message to the collector's loopback gateway with the local
 * bearer, and writes the answer to stdout. Every decision — attribution, the
 * tool ceiling, the forward to the control plane, the evidence — happens in
 * the gateway, in the daemon, once.
 *
 * The bearer arrives in `TACHO_LOCAL_TOKEN` rather than on the command line,
 * so it is not in the process listing. If it is absent the shim reads
 * `host.json` itself, which is the same file the hook reads and is mode 0600.
 */
import { createInterface } from "node:readline";
import { agentPathsForEnrollment } from "../host/agents";
import { readHostFile } from "../host/host-file";
import { tachoHome } from "../host/paths";
import { MCP_STREAMABLE_HTTP_ACCEPT } from "../wire";

export interface McpStdioOptions {
  /** The enrollment this config entry was written for. */
  enrollment?: string;
  /** The collector's loopback port. */
  port?: number;
}

export interface McpStdioDeps {
  stdin: NodeJS.ReadableStream;
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
  env: Record<string, string | undefined>;
  home?: string;
  fetch: typeof globalThis.fetch;
}

/** Longer than any tool call should take, shorter than forever. */
const GATEWAY_TIMEOUT_MS = 5 * 60_000;

/** A JSON-RPC error the shim itself answers, when it cannot reach the gateway. */
export function shimError(
  id: unknown,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code: -32002, message },
  };
}

/**
 * True for a JSON-RPC error whose id is null or missing. JSON-RPC sends that
 * id when the server could not read the request's id, and the MCP SDK
 * transport sends it for every POST it refuses before reading the body.
 */
function answersNoRequest(message: object): boolean {
  if (Array.isArray(message) || !("error" in message)) return false;
  const id = (message as { id?: unknown }).id;
  return id === null || id === undefined;
}

/**
 * Where the shim posts and what it presents. Flags win over `host.json`, so a
 * config entry written by an enrollment keeps working even if a later
 * enrollment moved the port — the entry names the port it was written with,
 * and a mismatch is refused by the gateway rather than silently retargeted.
 */
export function resolveTarget(
  options: McpStdioOptions,
  deps: Pick<McpStdioDeps, "env" | "home">,
): { ok: true; url: string; token: string } | { ok: false; message: string } {
  // The entry names the enrollment it was written for, and a machine can
  // hold one enrollment per agent (ADR-203). An entry written before entries
  // named their enrollment gets the oldest agent.
  const paths = agentPathsForEnrollment(
    tachoHome(deps.env, deps.home),
    options.enrollment,
    undefined,
  );
  let host: ReturnType<typeof readHostFile>;
  try {
    host = readHostFile(paths.hostFile);
  } catch {
    host = undefined;
  }
  const port = options.port ?? host?.port;
  const token = deps.env["TACHO_LOCAL_TOKEN"] ?? host?.local_token;
  if (port === undefined || token === undefined) {
    return {
      ok: false,
      message:
        "this machine is not enrolled with Oxagen, so there are no tools to serve. Open the Oxagen app, sign in and connect this app, then restart it.",
    };
  }
  const suffix =
    options.enrollment !== undefined ? `/${options.enrollment}` : "";
  return { ok: true, url: `http://127.0.0.1:${port}/mcp${suffix}`, token };
}

/**
 * Run the shim until stdin closes. One line in, one line out; a line that is
 * not JSON is answered rather than crashing the process, because a client
 * that loses its server mid-conversation shows the user nothing useful.
 */
export async function runMcpStdio(
  options: McpStdioOptions,
  deps: McpStdioDeps,
): Promise<number> {
  const target = resolveTarget(options, deps);
  const lines = createInterface({ input: deps.stdin, crlfDelay: Infinity });
  let sessionId: string | undefined;

  for await (const line of lines) {
    const text = line.trim();
    if (text.length === 0) continue;
    let id: unknown;
    let method: unknown;
    try {
      ({ id, method } = JSON.parse(text) as { id?: unknown; method?: unknown });
    } catch {
      deps.stdout.write(
        `${JSON.stringify(shimError(null, "the shim received a line that is not JSON"))}\n`,
      );
      continue;
    }
    // JSON-RPC: only a request is answered, with a result or with an error. A
    // notification has no id. A client's answer to a server request has an id
    // but no method, and its id belongs to the server's numbering, so a reply
    // with that id could match one of the client's own requests.
    const expectsReply = id !== undefined && typeof method === "string";
    const reply = (document: Record<string, unknown>) => {
      if (expectsReply) deps.stdout.write(`${JSON.stringify(document)}\n`);
    };
    if (!target.ok) {
      reply(shimError(id, target.message));
      continue;
    }
    try {
      const response = await deps.fetch(target.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
          // The two media types the MCP transport requires of a client. The
          // local gateway always answers with JSON, which this accepts.
          Accept: MCP_STREAMABLE_HTTP_ACCEPT,
          // Loopback, so this is not a real origin check — it is here so the
          // gateway's guard sees a Host it recognises even behind a proxy
          // that rewrites one.
          Host: new URL(target.url).host,
          ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
        },
        body: text,
        // The loop is sequential, so a call that never returns would stop
        // every later one. A tool call can be slow; five minutes is not slow.
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      const assigned = response.headers.get("mcp-session-id");
      if (assigned !== null && assigned.length > 0) sessionId = assigned;
      const body = (await response.text()).trim();
      // Only a line the client can parse goes to stdout. A proxy's
      // "Unauthorized", or the empty body of a 202, written raw, is a line
      // the client fails to parse and drops the server over.
      let parsed: unknown;
      try {
        parsed = body.length > 0 ? JSON.parse(body) : undefined;
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === "object" && parsed !== null) {
        if (expectsReply && answersNoRequest(parsed)) {
          // An error with a null or missing id matches no request, so the
          // client would wait out its own timeout (#5356). It answers this
          // line, so it takes this line's id.
          reply({ ...(parsed as Record<string, unknown>), id });
        } else if (expectsReply) {
          deps.stdout.write(`${body}\n`);
        }
      } else if (!response.ok || (expectsReply && body.length > 0)) {
        deps.stderr.write(
          `oxagen mcp-stdio: the gateway answered ${response.status}: ${body.slice(0, 200)}\n`,
        );
        reply(
          shimError(
            id,
            `the Oxagen collector on this machine answered ${response.status}. Open the Oxagen app to check this app is connected.`,
          ),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.stderr.write(`oxagen mcp-stdio: ${message}\n`);
      reply(
        shimError(
          id,
          `the Oxagen collector on this machine is not answering (${message}). Open the Oxagen app to check it is running.`,
        ),
      );
    }
  }
  return 0;
}
