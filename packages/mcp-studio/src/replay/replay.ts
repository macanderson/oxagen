// replay.ts: run one line of a server's tests/calls.jsonl with no network
// (mcp-studio-spec, Try it and tests: replay in the PR).
//
// replayCall runs the recorded call through the executor (lane M6) against a
// Transport that serves each recorded response in order. For a tool built
// from a definition (OpenAPI or GraphQL), each request the executor builds
// must match its recorded request. Every recorded exchange must be used, and
// the shaped result must match the recorded result. The first difference is
// the one reported.
//
// The replay sends no credential: a recorded request holds none, because
// Save as test records each request before the credential is added.
import type { ManifestServer, ManifestTool } from "../contract/manifest";
import type { RecordedCall } from "../contract/tests-files";
import { executeCall, type CallEnvironment, type ExecuteOptions } from "../execute/call";
import type { CredentialSource } from "../execute/credentials";
import { createGraphqlSender } from "../execute/graphql";
import { createHttpSender } from "../execute/http";
import { createMcpSender } from "../execute/mcp";
import type { CallToolResult } from "../execute/transport";
import { describePath, describeValue, firstDifference } from "./compare";
import { replayTransport, type ReplayRoute } from "./transport";

/** Where a replay first differs from its recording. */
export interface ReplayDifference {
  /**
   * request: a built request differs from its recording. response: a
   * recorded response does not fit the request. exchanges: the executor sent
   * more or fewer requests than the recording holds. result: the shaped
   * result differs from the recorded result.
   */
  part: "request" | "response" | "exchanges" | "result";
  /** 1-based: the exchange the difference is in, for request and response. */
  exchange?: number;
  /** Where in the request or result the values differ, such as body.amount. Empty for the whole value. */
  path: string;
  /** What the recording holds there. */
  expected: unknown;
  /** What the replay produced there. */
  actual: unknown;
  /** One or two sentences a person reads in the compile check. */
  message: string;
}

export type ReplayResult =
  /** The replay matched the recording and used this many exchanges. */
  | { status: "match"; exchanges: number }
  | { status: "differs"; difference: ReplayDifference }
  /** The replay did not run, for the reason given. */
  | { status: "skipped"; reason: string };

/** Replay waits for nothing: no backoff between retries, and a clock that stays at zero for paging. */
const NO_WAIT = () => 0;

const REPLAY_OPTIONS: ExecuteOptions = {
  senders: {
    http: createHttpSender({ backoff_ms: NO_WAIT }),
    graphql: createGraphqlSender({ backoff_ms: NO_WAIT }),
    mcp: createMcpSender({ backoff_ms: NO_WAIT }),
  },
  now: NO_WAIT,
};

/** The replay runs with the server's auth removed, so the executor never asks for a credential. */
const NO_CREDENTIALS: CredentialSource = {
  resolve: () => Promise.reject(new Error("Replay sends no credential.")),
};

/**
 * The value calls.jsonl records as a call's result: the shaped result's
 * structuredContent, or its text when it has none. Studio's Save as test
 * records this value, and replay compares it.
 */
export function recordedResult(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  return result.content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

/** The environment a replay runs in: the sandbox, or the first one when none is marked. */
function replayEnvironment(server: ManifestServer): string | undefined {
  const names = Object.keys(server.environments);
  return names.find((name) => server.environments[name]?.sandbox === true) ?? names[0];
}

function replayRoute(server: ManifestServer, environment: string, tool: ManifestTool): ReplayRoute {
  if (server.environments[environment]?.network === "local") return "local";
  return tool.request.kind === "mcp" ? "mcp" : "http";
}

/** The text of an error result, as a sentence to append to a message. */
function errorNote(result: CallToolResult): string {
  if (result.isError !== true) return "";
  return ` The call ended with an error: ${String(recordedResult(result))}`;
}

function differs(difference: ReplayDifference): ReplayResult {
  return { status: "differs", difference };
}

/** Replay one recorded call against a server from the tool manifest. */
export async function replayCall(server: ManifestServer, call: RecordedCall): Promise<ReplayResult> {
  const tool = Object.hasOwn(server.tools, call.tool) ? server.tools[call.tool] : undefined;
  if (tool === undefined) {
    return { status: "skipped", reason: `${call.tool} is not in tools.toml, so replay skips its recorded calls.` };
  }
  if (tool.request.kind === "grpc") return { status: "skipped", reason: "Replay does not run gRPC tools." };
  const name = replayEnvironment(server);
  if (name === undefined) return { status: "skipped", reason: `The server ${server.name} has no environment to replay in.` };

  const replay = replayTransport(call.exchanges, replayRoute(server, name, tool));
  const environment: CallEnvironment = { server: { ...server, auth: null }, name, operator: undefined };
  const { result, exchanges } = await executeCall(
    tool,
    call.arguments,
    environment,
    NO_CREDENTIALS,
    replay.transport,
    REPLAY_OPTIONS,
  );

  if (tool.request.kind === "http" || tool.request.kind === "graphql") {
    const shared = Math.min(exchanges.length, call.exchanges.length);
    for (let index = 0; index < shared; index++) {
      const found = firstDifference(call.exchanges[index]?.request, exchanges[index]?.request);
      if (found === undefined) continue;
      return differs({
        part: "request",
        exchange: index + 1,
        ...found,
        message:
          `Exchange ${index + 1}'s request differs ${describePath(found.path)}: the recording has ` +
          `${describeValue(found.expected)}, and the build has ${describeValue(found.actual)}.`,
      });
    }
  }

  const problem = replay.problem();
  if (problem !== undefined) {
    const { part, exchange, expected, actual, message } = problem;
    return differs({ part, exchange, path: "", expected, actual, message });
  }

  const used = replay.used();
  if (used !== call.exchanges.length) {
    return differs({
      part: "exchanges",
      path: "",
      expected: call.exchanges.length,
      actual: used,
      message: `The replay used ${used} of the ${call.exchanges.length} recorded exchanges.${errorNote(result)}`,
    });
  }

  const found = firstDifference(call.result, recordedResult(result));
  if (found !== undefined) {
    return differs({
      part: "result",
      ...found,
      message:
        `The result differs ${describePath(found.path)}: the recording has ${describeValue(found.expected)}, ` +
        `and the replay has ${describeValue(found.actual)}.${errorNote(result)}`,
    });
  }
  return { status: "match", exchanges: used };
}
