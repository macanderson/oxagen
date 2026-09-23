/**
 * `tacho run --contained -- <claude|codex> [args...]`: ask the local daemon to
 * start one agent run under the contained launcher (ADR-096, ADR-152).
 *
 * This process holds nothing the run needs. It names the harness, the
 * operator's image, the repository, and optionally a GitHub installation
 * token, then streams what the daemon streams back. The daemon measures the
 * container, registers it with Oxagen, and only then starts the agent. The
 * run's tier is computed by the control plane from that record, never here.
 */
import { request } from "node:http";
import { readHostFile } from "../host/host-file";
import type { CliDeps } from "./deps";

/** The agent names this command accepts, and the harness each one is. */
export const CONTAINED_AGENTS = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
} as const;

/** The environment variable a GitHub installation token is read from. */
export const CONTAINED_GITHUB_TOKEN_ENV = "OXAGEN_CONTAINED_GITHUB_TOKEN";
/** The environment variable the operator's image is read from. */
export const CONTAINED_IMAGE_ENV = "OXAGEN_CONTAINED_IMAGE";

export interface ContainedRunCommand {
  agent: string | undefined;
  args: string[];
  image?: string;
  workspace?: string;
  githubRepository?: string;
}

/** One NDJSON line the daemon's `/contained/run` writes. */
type RunLine =
  | { stream: "stdout" | "stderr"; text: string }
  | { result: { sessionId: string; exitCode: number } }
  | { error: string };

export interface ContainedStreamRequest {
  socketPath?: string;
  loopbackPort?: number;
  token: string;
  body: string;
  onLine: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * POST to the daemon and hand back each NDJSON line as it arrives. A run can
 * take an hour, so there is a connect budget and no response budget. Closing
 * the request is how the daemon learns to stop the container.
 */
export function streamDaemon(options: ContainedStreamRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...(options.socketPath !== undefined
          ? { socketPath: options.socketPath }
          : { host: "127.0.0.1", port: options.loopbackPort }),
        path: "/contained/run",
        method: "POST",
        agent: false,
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(options.body),
        },
      },
      (res) => {
        let buffered = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffered += chunk;
          let newline = buffered.indexOf("\n");
          while (newline !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (line.length > 0) options.onLine(line);
            newline = buffered.indexOf("\n");
          }
        });
        res.on("end", () => {
          if (buffered.length > 0) options.onLine(buffered);
          resolve(res.statusCode ?? 0);
        });
        res.on("error", reject);
      },
    );
    const connect = setTimeout(
      () => req.destroy(new Error("The daemon did not accept the connection")),
      5_000,
    );
    req.on("socket", (socket) =>
      socket.connecting
        ? socket.once("connect", () => clearTimeout(connect))
        : clearTimeout(connect),
    );
    req.on("error", (error) => {
      clearTimeout(connect);
      reject(error);
    });
    options.signal?.addEventListener(
      "abort",
      () => req.destroy(new Error("Contained run interrupted")),
      { once: true },
    );
    req.end(options.body);
  });
}

export interface ContainedRunDeps
  extends Pick<CliDeps, "paths" | "env" | "platform" | "err"> {
  cwd: string;
  write: (stream: "stdout" | "stderr", text: string) => void;
  stream?: (options: ContainedStreamRequest) => Promise<number>;
  signal?: AbortSignal;
}

/** Returns the process exit code: the agent's, or 1 when the run never started. */
export async function runContained(
  command: ContainedRunCommand,
  deps: ContainedRunDeps,
): Promise<number> {
  const harness =
    command.agent === undefined
      ? undefined
      : CONTAINED_AGENTS[command.agent as keyof typeof CONTAINED_AGENTS];
  if (harness === undefined) {
    deps.err(
      "Name the agent after --: `tacho run --contained -- claude -p <task>` or `-- codex exec <task>`.",
    );
    return 2;
  }
  const image = command.image ?? deps.env[CONTAINED_IMAGE_ENV];
  if (image === undefined || image.length === 0) {
    deps.err(
      `Name the contained image with --image or ${CONTAINED_IMAGE_ENV}. Build it from packages/tacho/container/Dockerfile.`,
    );
    return 2;
  }
  const host = readHostFile(deps.paths.hostFile);
  if (host === undefined) {
    deps.err("This machine is not enrolled. Run `tacho enroll` first.");
    return 1;
  }
  const token = deps.env[CONTAINED_GITHUB_TOKEN_ENV];
  const repository =
    command.githubRepository ??
    (token !== undefined ? deps.env["GITHUB_REPOSITORY"] : undefined);
  if (repository !== undefined && (token === undefined || token.length === 0)) {
    deps.err(
      `--github-repository needs an installation token for it in ${CONTAINED_GITHUB_TOKEN_ENV}.`,
    );
    return 2;
  }
  if (token !== undefined && token.length > 0 && repository === undefined) {
    deps.err(
      `${CONTAINED_GITHUB_TOKEN_ENV} is set; name its one repository with --github-repository owner/name.`,
    );
    return 2;
  }
  const body = JSON.stringify({
    workspace: command.workspace ?? deps.cwd,
    harness,
    args: command.args,
    image,
    ...(repository !== undefined && token !== undefined
      ? { github: { repository, token } }
      : {}),
  });
  let exitCode: number | undefined;
  let failure: string | undefined;
  const stream = deps.stream ?? streamDaemon;
  let status: number;
  try {
    status = await stream({
      ...(deps.platform === "win32"
        ? { loopbackPort: host.port }
        : { socketPath: deps.paths.socket }),
      token: host.local_token,
      body,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      onLine: (raw) => {
        let line: RunLine;
        try {
          line = JSON.parse(raw) as RunLine;
        } catch {
          return;
        }
        if ("stream" in line) deps.write(line.stream, line.text);
        else if ("result" in line) exitCode = line.result.exitCode;
        else if ("error" in line) failure = line.error;
      },
    });
  } catch (error) {
    deps.err(
      `The contained run could not reach tachod: ${error instanceof Error ? error.message : String(error)}. Is the daemon running?`,
    );
    return 1;
  }
  if (status === 404) {
    deps.err(
      "This tachod cannot start contained runs. Upgrade tacho on this runner.",
    );
    return 1;
  }
  if (failure !== undefined) {
    deps.err(`The contained run did not complete: ${failure}`);
    return 1;
  }
  if (exitCode === undefined) {
    deps.err("tachod ended the stream without a result.");
    return 1;
  }
  return exitCode;
}
