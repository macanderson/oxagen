// call.ts: one tool call from the manifest, start to end (mcp-studio-spec,
// Call path, steps 3 and 5 to 9).
//
// executeCall validates the agent's arguments, shapes them into the
// upstream's, resolves the credential, sends through the Sender for the
// request template kind, pages when tools.toml asks, and shapes the result.
// It returns the result and every exchange, one per page, each recorded as
// built before the credential was added, so Studio can save the call as a
// test. The decision (step 4) happened before it was called.
import { randomUUID } from "node:crypto";
import type { ManifestServer, ManifestTool } from "../contract/manifest";
import type { RecordedExchange } from "../contract/tests-files";
import type { CredentialSource } from "./credentials";
import { sendFailure } from "./http-call";
import { sendLocal, toolResult } from "./mcp";
import { errorText, pagingNote, sendPages } from "./paging";
import type { SendContext, SendCredential, Senders, SendResult, UpstreamArguments } from "./sender";
import { defaultSenders } from "./senders";
import { shapeArguments } from "./shape-input";
import { byteLength, resultRules, shapeJson, shapeToolResult, shapeValue } from "./shape-result";
import type { CallToolResult, Transport } from "./transport";
import { inputRefusal } from "./validate";

/** Where a call runs: the server, the environment, and the person running the agent. */
export interface CallEnvironment {
  server: ManifestServer;
  /** A key of server.environments: the sandbox for an agent's call, or the one an operator picked in Try it. */
  name: string;
  /** The operator, for operator-oauth. */
  operator: string | undefined;
}

export interface ExecuteOptions {
  /** A Sender to use in place of the default for its kind. */
  senders?: Partial<Senders>;
  /** Cancels the call: the credential lookup and every send. */
  signal?: AbortSignal;
  /** Milliseconds since the epoch, for the paging deadline. Tests pass a clock. */
  now?: () => number;
}

export interface ExecutedCall {
  /** The tools/call result the agent receives. */
  result: CallToolResult;
  /**
   * Every upstream exchange in the order it was sent, one per page for a
   * paged call. Each request is recorded as built before the credential was
   * added, and no response keeps a Set-Cookie header.
   */
  exchanges: RecordedExchange[];
}

function failed(text: string, exchanges: RecordedExchange[] = []): ExecutedCall {
  return { result: { content: [{ type: "text", text }], isError: true }, exchanges };
}

/** Send through the Sender for the template's kind. */
function dispatch(senders: Senders, tool: ManifestTool, args: UpstreamArguments, context: SendContext): Promise<SendResult> {
  const template = tool.request;
  switch (template.kind) {
    case "mcp":
      return senders.mcp.send(template, args, context);
    case "http":
      return senders.http.send(template, args, context);
    case "graphql":
      return senders.graphql.send(template, args, context);
    case "grpc":
      return senders.grpc.send(template, args, context);
  }
}

/**
 * Run one call. Bad arguments, an unknown environment, a missing operator
 * token, and an upstream failure are isError results. It rejects only when
 * the CredentialSource rejects.
 */
export async function executeCall(
  tool: ManifestTool,
  args: Record<string, unknown>,
  environment: CallEnvironment,
  credentials: CredentialSource,
  transport: Transport,
  options: ExecuteOptions = {},
): Promise<ExecutedCall> {
  const badArguments = inputRefusal(tool.definition.inputSchema, args);
  if (badArguments !== null) return failed(badArguments);

  const { server, name } = environment;
  const env = Object.hasOwn(server.environments, name) ? server.environments[name] : undefined;
  if (env === undefined) return failed(`The server ${server.name} has no environment named ${name}.`);

  const shaping = tool.shaping;
  const upstream = shapeArguments(args, shaping);
  const signal = options.signal ?? new AbortController().signal;

  let credential: SendCredential = { type: "none" };
  if (server.auth !== null) {
    const resolved = await credentials.resolve(
      { server: server.name, environment: name, reference: env.credential, auth: server.auth, operator: environment.operator },
      signal,
    );
    if (resolved.type === "missing") return failed(`${resolved.message}\n${resolved.connect_url}`);
    credential = resolved;
  }

  const senders: Senders = {
    mcp: options.senders?.mcp ?? defaultSenders.mcp,
    http: options.senders?.http ?? defaultSenders.http,
    graphql: options.senders?.graphql ?? defaultSenders.graphql,
    grpc: options.senders?.grpc ?? defaultSenders.grpc,
  };
  const local = env.network === "local";
  const send = async (sent: UpstreamArguments, deadline_ms: number): Promise<SendResult> => {
    const context: SendContext = {
      server,
      environment: { name, url: env.url, network: env.network },
      auth: server.auth,
      credential,
      transport,
      shaping: deadline_ms === shaping.deadline_ms ? shaping : { ...shaping, deadline_ms },
      // One key per send, so each page is its own request and every retry of it repeats the key.
      idempotency_key: shaping.idempotency_header === undefined ? undefined : randomUUID(),
      signal,
    };
    try {
      return local ? await sendLocal(tool, sent, context) : await dispatch(senders, tool, sent, context);
    } catch (error) {
      return sendFailure(error, local ? "local" : tool.request.kind);
    }
  };

  const rules = resultRules(shaping, tool.paging);
  const kind = tool.request.kind;
  const notes: string[] = [];
  let value: unknown;
  let exchanges: RecordedExchange[];
  if (!local && shaping.paginate !== undefined && tool.paging !== undefined && (kind === "http" || kind === "graphql")) {
    const paged = await sendPages(
      tool.paging,
      upstream,
      {
        shaping,
        inputSchema: tool.definition.inputSchema,
        agentName: (input) => (Object.hasOwn(shaping.rename, input) ? (shaping.rename[input] ?? input) : input),
        measure: (page) => byteLength(JSON.stringify(shapeJson(page, rules))),
        now: options.now,
      },
      send,
    );
    if (!paged.ok) return failed(errorText(paged.error), paged.exchanges);
    value = paged.value;
    exchanges = paged.exchanges;
    const note = paged.paged === undefined ? undefined : pagingNote(paged.paged, { shaping });
    if (note !== undefined) notes.push(note);
  } else {
    const sent = await send(upstream, shaping.deadline_ms);
    // SendResult leaves exchanges optional. The HTTP and GraphQL Senders
    // return none when a request fails to build and nothing is sent, and a
    // Sender passed in options.senders may leave them out. The gRPC Sender
    // always returns them, so this fallback never hides one of its calls.
    exchanges = sent.exchanges ?? [];
    if (!sent.ok) return failed(errorText(sent.error), exchanges);
    value = sent.value;
  }

  if (local || kind === "mcp") {
    const checked = toolResult(value);
    if (checked.ok) return { result: shapeToolResult(checked.value, rules, notes), exchanges };
  }
  return { result: shapeValue(value, rules, notes), exchanges };
}
