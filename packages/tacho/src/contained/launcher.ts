import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { validateContainedArguments } from "./configuration";
import { validateContainedWorkspace } from "./workspace";
import {
  containerArguments,
  measureContainer,
  type ContainedHarness,
  type ContainmentMeasurement,
} from "./profile";

const exec = promisify(execFile);
export interface ContainedRunRequest {
  workspace: string;
  harness: ContainedHarness;
  args: string[];
}
export interface ContainedRunResult {
  sessionId: string;
  exitCode: number;
  measurement: ContainmentMeasurement;
}
export interface ContainedLauncherOptions {
  /** Operator-selected image, outside the agent's request and environment. */
  image: string;
  request: ContainedRunRequest;
  prepare: (context: {
    sessionId: string;
    directory: string;
    workspace: string;
  }) => Promise<{
    files: Record<string, string>;
    close: () => Promise<void>;
  }>;
  /** Must persist trusted launch provenance before Docker starts the agent. */
  measured: (
    sessionId: string,
    measurement: ContainmentMeasurement,
  ) => Promise<void>;
  sealed: (sessionId: string, exitCode: number) => Promise<void>;
  output: (stream: "stdout" | "stderr", text: string) => void;
  signal?: AbortSignal;
}

/** The daemon owns this lifecycle; no request accepts caller measurements. */
export async function launchContainedAgent(
  options: ContainedLauncherOptions,
): Promise<ContainedRunResult> {
  validateContainedArguments(options.request.harness, options.request.args);
  if (process.platform !== "linux" || process.getuid?.() === 0)
    throw new Error(
      "Contained execution requires an unprivileged Linux runner with Docker",
    );
  if (!isAbsolute(options.request.workspace))
    throw new Error("Contained workspace must be an absolute repository path");
  const workspace = realpathSync(options.request.workspace);
  const root = await exec("git", [
    "-C",
    workspace,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (realpathSync(root.stdout.trim()) !== workspace)
    throw new Error("Contained workspace must be the repository root");
  const docker = await exec("docker", ["info", "--format", "{{.OSType}}"], {
    timeout: 15_000,
  });
  if (docker.stdout.trim() !== "linux")
    throw new Error("Docker cannot provide the Linux containment profile");
  const image = JSON.parse(
    (
      await exec("docker", ["image", "inspect", options.image], {
        timeout: 15_000,
      })
    ).stdout,
  ) as Array<{ Id?: string }>;
  const digest = image[0]?.Id;
  if (digest === undefined)
    throw new Error("The operator's contained image is not installed");
  const sessionId = `contained-${randomBytes(16).toString("hex")}`;
  const directory = mkdtempSync(join(tmpdir(), "oxagen-contained-"));
  chmodSync(directory, 0o700);
  let prepared:
    | Awaited<ReturnType<ContainedLauncherOptions["prepare"]>>
    | undefined;
  let containerCreated = false;
  let admitted = false;
  let exitCode = 1;
  const name = `oxagen-${sessionId}`;
  try {
    const rel = relative(workspace, directory);
    if (!rel.startsWith("..") && !isAbsolute(rel))
      throw new Error(
        "Contained configuration must be outside the writable repository",
      );
    validateContainedWorkspace(workspace, directory);
    prepared = await options.prepare({ sessionId, directory, workspace });
    const entries = Object.entries(prepared.files).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [name, contents] of entries) {
      if (!/^[a-z0-9.-]+$/.test(name))
        throw new Error("Invalid contained configuration filename");
      writeFileSync(join(directory, name), contents, {
        mode: 0o400,
        flag: "wx",
      });
    }
    const spec = {
      name,
      image: digest,
      workspace,
      sessionDirectory: directory,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      harness: options.request.harness,
      args: options.request.args,
    };
    await exec("docker", containerArguments(spec), { timeout: 30_000 });
    containerCreated = true;
    const inspected = JSON.parse(
      (await exec("docker", ["inspect", name], { timeout: 15_000 })).stdout,
    ) as unknown[];
    const measurement = measureContainer(
      inspected[0],
      spec,
      JSON.stringify(entries),
    );
    await options.measured(sessionId, measurement);
    admitted = true;
    if (options.signal?.aborted)
      throw new Error("Contained run cancelled before start");
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("docker", ["start", "--attach", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stop = () => {
        void exec("docker", ["kill", name], { timeout: 15_000 }).catch(
          () => undefined,
        );
      };
      options.signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) =>
        options.output("stdout", chunk.toString("utf8")),
      );
      child.stderr.on("data", (chunk: Buffer) =>
        options.output("stderr", chunk.toString("utf8")),
      );
      child.once("error", reject);
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", stop);
        resolve(code ?? 1);
      });
    });
    return { sessionId, exitCode, measurement };
  } finally {
    if (containerCreated)
      await exec("docker", ["rm", "--force", name], { timeout: 15_000 }).catch(
        () => undefined,
      );
    try {
      if (admitted) await options.sealed(sessionId, exitCode);
    } finally {
      await prepared?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
