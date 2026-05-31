import { IMAGES } from "./images.js";
import type {
  SandboxDriver,
  SandboxRequest,
  SandboxResult,
  SandboxStreamChunk,
} from "./types.js";

/**
 * Modal sandbox driver. Talks to Modal's Sandbox HTTP API via a thin
 * function-as-a-service shim deployed once (see ops/modal/runner.py),
 * which accepts {language, code, env, timeoutMs, memoryMb, network} and
 * returns the captured exec result.
 *
 * We don't use the Python SDK directly because @oxagen/sandbox runs in
 * Node. The shim is the seam: it owns the Modal-specific calls (image
 * selection, Sandbox.create, sb.exec, sb.terminate) and gives us a
 * language-agnostic HTTP contract.
 *
 * Free tier: Modal grants $30/month of compute credits with no card
 * attached. A typical agent code run is sub-cent at our default limits,
 * so the free tier carries development + early production for free.
 *
 * Configure via env:
 *   MODAL_RUNNER_URL       — https://<workspace>--oxagen-sandbox.modal.run
 *   MODAL_RUNNER_TOKEN     — shared secret minted at deploy time
 */
export interface ModalSandboxConfig {
  runnerUrl: string;
  runnerToken: string;
  fetchImpl?: typeof fetch;
}

interface ModalRunRequest {
  language: SandboxRequest["language"];
  code: string;
  stdin?: string;
  env?: Record<string, string>;
  timeout_ms: number;
  memory_mb: number;
  network: "allow" | "deny";
  org_id: string;
  workspace_id: string;
  image: string;
}

interface ModalRunResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  oom_killed: boolean;
}

function toRunnerBody(req: SandboxRequest): ModalRunRequest {
  const spec = IMAGES[req.language];
  return {
    language: req.language,
    code: req.code,
    stdin: req.stdin,
    env: req.env,
    timeout_ms: req.timeoutMs,
    memory_mb: req.memoryMb,
    network: req.network,
    org_id: req.orgId,
    workspace_id: req.workspaceId,
    // The runner uses this for image selection; we keep the source of
    // truth in @oxagen/sandbox/images so swapping drivers is a config
    // change, not an image-pinning migration.
    image: spec.image,
  };
}

export function createModalSandbox(config: ModalSandboxConfig): SandboxDriver {
  const fetchImpl = config.fetchImpl ?? fetch;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.runnerToken}`,
  };

  return {
    name: "modal",
    async run(req: SandboxRequest): Promise<SandboxResult> {
      const body = JSON.stringify(toRunnerBody(req));
      // Add a small overhead to the HTTP timeout so the runner can
      // report its own timeout cleanly instead of us aborting first.
      const controller = new AbortController();
      const httpTimeout = setTimeout(
        () => controller.abort(),
        req.timeoutMs + 15_000,
      );
      try {
        const res = await fetchImpl(`${config.runnerUrl}/run`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`modal runner ${res.status}: ${text.slice(0, 500)}`);
        }
        const data = (await res.json()) as ModalRunResponse;
        return {
          exitCode: data.exit_code,
          stdout: data.stdout,
          stderr: data.stderr,
          durationMs: data.duration_ms,
          timedOut: data.timed_out,
          oomKilled: data.oom_killed,
        };
      } finally {
        clearTimeout(httpTimeout);
      }
    },
    // Falls back to buffered run(); streaming over SSE is not yet wired.
    async *stream(req: SandboxRequest): AsyncIterable<SandboxStreamChunk> {
      const result = await this.run(req);
      const now = Date.now();
      if (result.stdout) {
        yield { channel: "stdout", data: result.stdout, at: now };
      }
      if (result.stderr) {
        yield { channel: "stderr", data: result.stderr, at: now };
      }
    },
  };
}
