import { Sandbox } from "@vercel/sandbox";
import type { NetworkPolicy, CommandFinished } from "@vercel/sandbox";
import { IMAGES } from "./images.js";
import type {
  SandboxDriver,
  SandboxLanguage,
  SandboxRequest,
  SandboxResult,
  SandboxStreamChunk,
} from "./types.js";

// @vercel/sandbox supports node24 and python3.13 runtimes only (see ADR-011).
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

export function createVercelSandbox(config: VercelSandboxConfig): SandboxDriver {
  const credentials = credentialsFor(config);

  async function run(req: SandboxRequest): Promise<SandboxResult> {
    if (req.stdin && req.stdin.length > 0) {
      throw new VercelSandboxUnsupportedError(
        "The Vercel sandbox driver does not support stdin. " +
          "Embed any required input directly in the code file.",
      );
    }

    const start = Date.now();
    const networkPolicy = networkPolicyFor(req.network);
    const runtime = runtimeFor(req.language);
    const filePath = codePathFor(req.language);
    const { cmd, args } = entrypointFor(req.language);

    const createParams = {
      runtime,
      networkPolicy,
      timeout: req.timeoutMs,
      env: req.env,
      resources: { vcpus: 1 },
      ...(credentials ?? {}),
    };

    const sandbox = await Sandbox.create(createParams);
    let finished: CommandFinished;
    try {
      await sandbox.fs.writeFile(filePath, req.code, "utf8");
      finished = await sandbox.runCommand({ cmd, args, env: req.env });
    } finally {
      await sandbox.stop().catch(() => undefined);
    }

    const durationMs = Date.now() - start;
    // Heuristic: treat the run as timed-out when wall-clock (including
    // Sandbox.create() + fs.writeFile() warmup) meets or exceeds the
    // configured limit. This can produce false positives for fast sandboxes
    // that exit near the boundary, and false negatives when warmup consumes
    // significant time.
    // TODO: adopt a dedicated timeout signal from @vercel/sandbox when the
    // SDK exposes one on CommandFinished (track via @vercel/sandbox release notes).
    const timedOut = durationMs >= req.timeoutMs;

    const stdout = await finished.stdout().catch(() => "");
    const stderr = await finished.stderr().catch(() => "");

    return {
      exitCode: finished.exitCode,
      stdout,
      stderr,
      durationMs,
      timedOut,
      // @vercel/sandbox does not surface an OOM flag; hardcode false.
      // See ADR-011 Consequences for the rationale.
      oomKilled: false,
    };
  }

  async function* stream(req: SandboxRequest): AsyncIterable<SandboxStreamChunk> {
    if (req.stdin && req.stdin.length > 0) {
      throw new VercelSandboxUnsupportedError(
        "The Vercel sandbox driver does not support stdin. " +
          "Embed any required input directly in the code file.",
      );
    }

    const networkPolicy = networkPolicyFor(req.network);
    const runtime = runtimeFor(req.language);
    const filePath = codePathFor(req.language);
    const { cmd, args } = entrypointFor(req.language);

    const createParams = {
      runtime,
      networkPolicy,
      timeout: req.timeoutMs,
      env: req.env,
      resources: { vcpus: 1 },
      ...(credentials ?? {}),
    };

    const sandbox = await Sandbox.create(createParams);
    try {
      await sandbox.fs.writeFile(filePath, req.code, "utf8");
      const command = await sandbox.runCommand({ cmd, args, env: req.env, detached: true });
      for await (const log of command.logs()) {
        yield {
          channel: log.stream,
          data: log.data,
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
