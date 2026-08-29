import { Sandbox } from "@vercel/sandbox";
import type { NetworkPolicy, CommandFinished } from "@vercel/sandbox";
import { IMAGES } from "./images";
import type {
  SandboxDriver,
  SandboxLanguage,
  SandboxRequest,
  SandboxResult,
  SandboxStreamChunk,
} from "./types";

// Maximum characters allowed in stdout or stderr from a single run().
// Mirrors the Docker driver's 8 MB cap (docker.ts:29).
const MAX_OUTPUT_CHARS = 8_388_608; // 8 MB

// @vercel/sandbox supports node24 and python3.13 runtimes only
// (see docs/adr/ADR-011-vercel-sandbox-driver.md).
// Shell scripts are executed via /bin/sh on the node24 runtime.
const LANGUAGE_RUNTIMES: Record<SandboxLanguage, string> = {
  node: "node24",
  python: "python3.13",
  shell: "node24",
} as const;

/**
 * Map a SandboxLanguage to the @vercel/sandbox runtime string.
 * Exported for testability.
 */
export function runtimeFor(lang: SandboxLanguage): string {
  return LANGUAGE_RUNTIMES[lang];
}

/**
 * Map a sandbox network setting to the @vercel/sandbox NetworkPolicy.
 * Exported for testability.
 */
export function networkPolicyFor(network: "allow" | "deny"): NetworkPolicy {
  return network === "deny" ? "deny-all" : "allow-all";
}

/**
 * Configuration for the Vercel Sandbox driver.
 *
 * All three fields are optional because Vercel Functions resolve auth via
 * OIDC automatically (VERCEL_OIDC_TOKEN is injected by the runtime).
 * For local dev outside a Vercel project, supply explicit credentials via
 * VERCEL_SANDBOX_TOKEN, VERCEL_SANDBOX_TEAM_ID, and VERCEL_SANDBOX_PROJECT_ID.
 */
export interface VercelSandboxConfig {
  token?: string;
  teamId?: string;
  projectId?: string;
}

/**
 * Thrown when the caller passes a non-empty `stdin` to the Vercel driver.
 * @vercel/sandbox's runCommand does not accept a stdin pipe; callers must
 * embed any required input in the code file itself.
 */
export class VercelSandboxUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VercelSandboxUnsupportedError";
  }
}

// Ceiling on vCPU (mirrors the contract's sandboxResourcesSchema.vcpu max).
const MAX_VCPU = 4;

// @vercel/sandbox runtimes are a fixed set (node24 / python3.13); it cannot pull
// an arbitrary container image. A template that pins a custom `runtime` image is
// incompatible with this driver — fail fast and loud rather than silently
// running the wrong (default) image.
function assertNoCustomImage(req: SandboxRequest): void {
  if (req.imageRef) {
    throw new VercelSandboxUnsupportedError(
      "Custom images are not supported on the vercel driver — its runtimes are " +
        "fixed (node24 / python3.13). Use the modal or docker provider for a " +
        "template with a custom runtime image.",
    );
  }
}

// A template's vcpu maps to @vercel/sandbox `resources.vcpus`; default 1.
function vcpusFor(req: SandboxRequest): number {
  if (req.vcpu && req.vcpu > 0) return Math.min(req.vcpu, MAX_VCPU);
  return 1;
}

// Build optional Credentials object only when all three values are present.
// The SDK resolves credentials from OIDC when none are provided.
function credentialsFor(
  config: VercelSandboxConfig,
): { token: string; teamId: string; projectId: string } | undefined {
  const { token, teamId, projectId } = config;
  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  return undefined;
}

// Derive the command entrypoint from the language.
// Docker's entrypoint arrays are not reusable here — the Vercel SDK's
// runCommand takes cmd + args separately and the shell case needs /bin/sh.
function entrypointFor(lang: SandboxLanguage): { cmd: string; args: string[] } {
  switch (lang) {
    case "node":
      return { cmd: "node", args: [IMAGES.node.codePath] };
    case "python":
      return { cmd: "python3", args: [IMAGES.python.codePath] };
    case "shell":
      // Shell scripts are written to /tmp/main.sh and invoked via /bin/sh.
      return { cmd: "/bin/sh", args: ["/tmp/main.sh"] };
  }
}

// The path where user code is written in the Vercel sandbox filesystem.
function codePathFor(lang: SandboxLanguage): string {
  if (lang === "shell") {
    // Use /tmp because the standard codePath (/work/main.sh) may not
    // exist on the node24 runtime; /tmp is always writable.
    return "/tmp/main.sh";
  }
  return IMAGES[lang].codePath;
}

// Directory the entrypoint code file lives in; extra workspace files are landed
// here so language-relative imports resolve next to the entrypoint.
function baseDirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

// Write each caller-supplied workspace file next to the entrypoint. Paths are
// already confined to the workspace root upstream (contract + handler). The
// Vercel fs writes create intermediate directories as needed.
async function writeWorkspaceFiles(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>,
  baseDir: string,
  files: Record<string, string> | undefined,
): Promise<void> {
  if (!files) return;
  for (const [rel, content] of Object.entries(files)) {
    await sandbox.fs.writeFile(`${baseDir}/${rel}`, content, "utf8");
  }
}

/** Subset of the Sandbox static API needed for mocking in tests. */
export interface SandboxFactory {
  create: (
    params: Parameters<typeof Sandbox.create>[0],
  ) => ReturnType<typeof Sandbox.create>;
}

export function createVercelSandbox(
  config: VercelSandboxConfig,
  sandboxImpl?: SandboxFactory,
): SandboxDriver {
  const credentials = credentialsFor(config);
  const SandboxImpl: SandboxFactory = sandboxImpl ?? Sandbox;

  async function run(req: SandboxRequest): Promise<SandboxResult> {
    if (req.stdin && req.stdin.length > 0) {
      throw new VercelSandboxUnsupportedError(
        "The Vercel sandbox driver does not support stdin. " +
          "Embed any required input directly in the code file.",
      );
    }
    assertNoCustomImage(req);

    const wallStart = Date.now();
    const networkPolicy = networkPolicyFor(req.network);
    const runtime = runtimeFor(req.language);
    const filePath = codePathFor(req.language);
    const { cmd, args } = entrypointFor(req.language);

    const createParams = {
      runtime,
      networkPolicy,
      timeout: req.timeoutMs,
      env: req.env,
      resources: { vcpus: vcpusFor(req) },
      ...(credentials ?? {}),
    };

    const sandbox = await SandboxImpl.create(createParams);
    let finished: CommandFinished;
    let execStart: number;
    try {
      await sandbox.fs.writeFile(filePath, req.code, "utf8");
      await writeWorkspaceFiles(sandbox, baseDirOf(filePath), req.files);
      // Measure execution time starting after file upload so that
      // Sandbox.create() + fs.writeFile() warmup (typically 1–3 s) is
      // excluded from the timedOut heuristic.
      execStart = Date.now();
      finished = await sandbox.runCommand({ cmd, args, env: req.env });
    } finally {
      await sandbox.stop().catch(() => undefined);
    }

    const durationMs = Date.now() - wallStart;
    const execDurationMs = Date.now() - execStart!;
    // Heuristic: treat the run as timed-out when execution time (excluding
    // sandbox warmup) meets or exceeds the configured limit. @vercel/sandbox
    // does not expose a dedicated timeout signal on CommandFinished
    // (see docs/adr/ADR-011-vercel-sandbox-driver.md).
    const timedOut = execDurationMs >= req.timeoutMs;

    const rawStdout = await finished.stdout().catch(() => "");
    const rawStderr = await finished.stderr().catch(() => "");
    const stdoutTruncated = rawStdout.length > MAX_OUTPUT_CHARS;
    const stderrTruncated = rawStderr.length > MAX_OUTPUT_CHARS;
    const stdout = stdoutTruncated
      ? rawStdout.slice(0, MAX_OUTPUT_CHARS) +
        "\n[output truncated: exceeded 8 MB limit]"
      : rawStdout;
    const stderr = stderrTruncated
      ? rawStderr.slice(0, MAX_OUTPUT_CHARS) +
        "\n[output truncated: exceeded 8 MB limit]"
      : rawStderr;

    return {
      exitCode: finished.exitCode,
      stdout,
      stderr,
      durationMs,
      timedOut,
      // @vercel/sandbox does not surface an OOM flag; hardcode false
      // (see docs/adr/ADR-011-vercel-sandbox-driver.md).
      oomKilled: false,
    };
  }

  async function* stream(
    req: SandboxRequest,
  ): AsyncIterable<SandboxStreamChunk> {
    if (req.stdin && req.stdin.length > 0) {
      throw new VercelSandboxUnsupportedError(
        "The Vercel sandbox driver does not support stdin. " +
          "Embed any required input directly in the code file.",
      );
    }
    assertNoCustomImage(req);

    const networkPolicy = networkPolicyFor(req.network);
    const runtime = runtimeFor(req.language);
    const filePath = codePathFor(req.language);
    const { cmd, args } = entrypointFor(req.language);

    const createParams = {
      runtime,
      networkPolicy,
      timeout: req.timeoutMs,
      env: req.env,
      resources: { vcpus: vcpusFor(req) },
      ...(credentials ?? {}),
    };

    const sandbox = await SandboxImpl.create(createParams);
    try {
      await sandbox.fs.writeFile(filePath, req.code, "utf8");
      await writeWorkspaceFiles(sandbox, baseDirOf(filePath), req.files);
      const command = await sandbox.runCommand({
        cmd,
        args,
        env: req.env,
        detached: true,
      });
      let streamedBytes = 0;
      for await (const log of command.logs()) {
        if (streamedBytes >= MAX_OUTPUT_CHARS) {
          yield {
            channel: log.stream,
            data: "\n[output truncated: exceeded 8 MB limit]",
            at: Date.now(),
          };
          break;
        }
        const chunk =
          log.data.length > MAX_OUTPUT_CHARS - streamedBytes
            ? log.data.slice(0, MAX_OUTPUT_CHARS - streamedBytes)
            : log.data;
        streamedBytes += chunk.length;
        yield {
          channel: log.stream,
          data: chunk,
          at: Date.now(),
        };
      }
    } finally {
      await sandbox.stop().catch(() => undefined);
    }
  }

  // Vercel sandboxes are ephemeral microVMs spun up per invocation.
  // Platform-level pooling is handled by Vercel's infrastructure;
  // there is nothing to warm up on the client side.
  async function warmup(): Promise<void> {
    // intentional no-op
  }

  return { run, stream, warmup, name: "vercel" };
}
