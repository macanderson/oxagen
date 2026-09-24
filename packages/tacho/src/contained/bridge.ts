import { chmodSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { HookEnvelope } from "../collector/server";
import {
  forwardToGitHub,
  gitHubTarget,
  type ContainedGitHub,
  type GitHubUpstreams,
} from "./github";
import type { ContainedHarness } from "./profile";

export interface ContainedBridgeOptions {
  socketPath: string;
  sessionId: string;
  workspace: string;
  harness: ContainedHarness;
  modelPort: number;
  issueCredential: () => string;
  model: (request: IncomingMessage, response: ServerResponse) => void;
  hook: (envelope: HookEnvelope) => Promise<Record<string, unknown>>;
  mcp: (body: unknown) => Promise<{
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }>;
  refused: (path: string) => void;
  /**
   * The run's GitHub grant, when the operator supplied one (ADR-152). The
   * token never crosses into the sandbox; the bridge adds it on the way out.
   */
  github?: ContainedGitHub;
  githubUpstreams?: GitHubUpstreams;
  /** Records a GitHub request the bridge forwarded for the run. */
  forwarded?: (method: string, path: string) => void;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 8 * 1024 * 1024)
      throw new Error("Contained request exceeds 8 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The container can reach only these operations, never daemon administration. */
export function containedBridgeHandler(options: ContainedBridgeOptions) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const path = request.url ?? "/";
      const modelPaths =
        options.harness === "claude-code"
          ? ["/model/v1/messages", "/model/v1/messages/count_tokens"]
          : ["/model/v1/responses", "/model/v1/chat/completions"];
      if (request.method === "POST" && modelPaths.includes(path)) {
        // Credentials and correlation are chosen outside the sandbox. Neither
        // the vendor key nor the daemon's administration bearer crosses it.
        const credential = options.issueCredential();
        request.headers = {
          "content-type": "application/json",
          ...(request.headers["content-length"]
            ? { "content-length": request.headers["content-length"] }
            : {}),
          ...(request.headers["anthropic-version"]
            ? { "anthropic-version": request.headers["anthropic-version"] }
            : {}),
          ...(request.headers["anthropic-beta"]
            ? { "anthropic-beta": request.headers["anthropic-beta"] }
            : {}),
          host: `127.0.0.1:${options.modelPort}`,
          "x-oxagen-session": options.sessionId,
          ...(options.harness === "claude-code"
            ? { "x-api-key": credential }
            : { authorization: `Bearer ${credential}` }),
        };
        request.url =
          options.harness === "claude-code"
            ? path.replace("/model", "/anthropic")
            : path.replace("/model", "/openai");
        options.model(request, response);
        return;
      }
      if (request.method === "POST" && path === "/hook") {
        const input = await readJson(request);
        if (typeof input !== "object" || input === null || Array.isArray(input))
          throw new Error("Invalid hook payload");
        const payload = {
          ...input,
          session_id: options.sessionId,
          cwd: options.workspace,
        } as Record<string, unknown>;
        delete payload["transcript_path"];
        delete payload["pid"];
        if (payload["hook_event_name"] === "SessionEnd") {
          send(response, 200, {});
          return;
        }
        send(
          response,
          200,
          await options.hook({ payload, harness: options.harness }),
        );
        return;
      }
      if (request.method === "POST" && path === "/mcp") {
        const result = await options.mcp(await readJson(request));
        response.writeHead(
          result.status,
          result.headers ?? { "content-type": "application/json" },
        );
        response.end(
          result.body === undefined ? undefined : JSON.stringify(result.body),
        );
        return;
      }
      if (options.github && path.startsWith("/github/")) {
        const target = gitHubTarget(
          path,
          options.github.repository,
          options.githubUpstreams,
        );
        if (target) {
          options.forwarded?.(request.method ?? "GET", path);
          forwardToGitHub(target, options.github.token, request, response);
          return;
        }
      }
      options.refused(path);
      send(response, 403, {
        error: "This route is outside the contained gateway",
      });
    })().catch(() => {
      if (!response.headersSent)
        send(response, 502, {
          error: "Contained gateway could not complete this request",
        });
      else response.destroy();
    });
  };
}

export async function startContainedBridge(
  options: ContainedBridgeOptions,
): Promise<{ close: () => Promise<void> }> {
  const server = createServer(containedBridgeHandler(options));
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.maxConnections = 64;
  server.on("upgrade", (_request, socket) =>
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      chmodSync(options.socketPath, 0o600);
      resolve();
    });
  });
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
