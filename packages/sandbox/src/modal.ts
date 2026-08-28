import { z } from "zod";
import { IMAGES } from "./images";
import type {
  SandboxDriver,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxRequest,
  SandboxResult,
  SandboxSessionHandle,
  SandboxSessionSpec,
  SandboxStreamChunk,
} from "./types";

/**
 * Modal sandbox driver. Talks to Modal's Sandbox HTTP API via a thin
 * function-as-a-service shim deployed once (see ops/modal-sandbox/runner.py),
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
  // Extra workspace files (relative path → contents) landed before the
  // entrypoint runs. The Modal runner shim (ops/modal-sandbox/runner.py) writes them
  // into the sandbox workdir; older shims that ignore the field run with the
  // entrypoint alone. Paths are pre-confined to the workspace upstream.
  files?: Record<string, string>;
  timeout_ms: number;
  memory_mb: number;
  network: "allow" | "deny";
  org_id: string;
  workspace_id: string;
  image: string;
  // Optional template resources; the runner clamps/ignores unknown fields, so
  // sending them is forward-compatible with an older shim.
  vcpu?: number;
  disk_mb?: number;
}

const ModalRunResponseSchema = z.object({
  exit_code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number(),
  timed_out: z.boolean(),
  oom_killed: z.boolean(),
});

type ModalRunResponse = z.infer<typeof ModalRunResponseSchema>;

// ── Durable-session runner contracts ─────────────────────────────────────────
// Mirror the runner's POST /sandbox/{create,exec,snapshot,restore,terminate,
// status} JSON shapes (ops/modal-sandbox/runner.py). Snake_case on the wire,
// camelCase at the SandboxDriver boundary.
const ModalSessionHandleSchema = z.object({
  sandbox_id: z.string(),
  status: z.literal("running"),
  created_at: z.string(),
});
const ModalExecResponseSchema = z.object({
  exit_code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number(),
  timed_out: z.boolean(),
  gone: z.boolean(),
  // Resulting working directory (durable-terminal cwd persistence). nullish so a
  // runner deployed before cwd support (omits the field) still parses cleanly.
  cwd: z.string().nullish(),
});
const ModalSnapshotResponseSchema = z.object({ snapshot_id: z.string() });
const ModalStatusResponseSchema = z.object({
  sandbox_id: z.string(),
  status: z.enum(["running", "gone"]),
});

function sessionBody(spec: SandboxSessionSpec) {
  return {
    image: spec.image,
    // A template's custom image ref (digest-pinned). Additive on the wire: a
    // runner that predates the field maps `image` (the kind) instead. Null when
    // the session uses a base-kind image.
    image_ref: spec.imageRef ?? null,
    memory_mb: spec.memoryMb,
    vcpu: spec.vcpu ?? null,
    disk_mb: spec.diskMb ?? null,
    ttl_seconds: spec.ttlSeconds,
    idle_timeout_seconds: spec.idleTimeoutSeconds,
    network: spec.network,
    org_id: spec.orgId,
    workspace_id: spec.workspaceId,
    setup_cmd: spec.setupCmd ?? null,
    // Trusted env for the setup exec only (environment vault secrets +
    // template literal_env), resolved server-side by agent.sandbox.start.
    // Additive on the wire: a runner deployed before the field ignores it and
    // runs setup_cmd env-less, exactly as before.
    setup_env: spec.setupEnv ?? null,
  };
}

function toRunnerBody(req: SandboxRequest): ModalRunRequest {
  const spec = IMAGES[req.language];
  return {
    language: req.language,
    code: req.code,
    stdin: req.stdin,
    env: req.env,
    files: req.files,
    timeout_ms: req.timeoutMs,
    memory_mb: req.memoryMb,
    network: req.network,
    org_id: req.orgId,
    workspace_id: req.workspaceId,
    // A template's custom image overrides the language default; otherwise the
    // source of truth stays in @oxagen/sandbox/images so swapping drivers is a
    // config change, not an image-pinning migration. The runner's `image` param
    // is the supported image seam, so imageRef is honored here (no throw).
    image: req.imageRef ?? spec.image,
    ...(req.vcpu !== undefined ? { vcpu: req.vcpu } : {}),
    ...(req.diskMb !== undefined ? { disk_mb: req.diskMb } : {}),
  };
}

export function createModalSandbox(config: ModalSandboxConfig): SandboxDriver {
  const fetchImpl = config.fetchImpl ?? fetch;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.runnerToken}`,
  };

  // Shared POST helper for the durable-session endpoints. The HTTP timeout is
  // the caller's logical timeout plus headroom so the runner can report its own
  // timeout cleanly instead of us aborting the connection first.
  async function postJson<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const httpTimeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${config.runnerUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `modal runner ${res.status} ${path}: ${text.slice(0, 500)}`,
        );
      }
      return schema.parse(await res.json());
    } finally {
      clearTimeout(httpTimeout);
    }
  }

  return {
    name: "modal",
    supportsSessions: true,
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
        const data: ModalRunResponse = ModalRunResponseSchema.parse(
          await res.json(),
        );
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

    // ── Durable sessions ──────────────────────────────────────────────────────
    async createSession(
      spec: SandboxSessionSpec,
    ): Promise<SandboxSessionHandle> {
      // Bound provisioning (image pull + optional clone/install via setup_cmd)
      // on a fixed 5-minute budget — NOT the session TTL, which is the whole-day
      // lifetime ceiling and would let a wedged create hang the request.
      const data = await postJson(
        "/sandbox/create",
        sessionBody(spec),
        ModalSessionHandleSchema,
        300_000,
      );
      return {
        sandboxId: data.sandbox_id,
        status: data.status,
        createdAt: data.created_at,
      };
    },

    async execInSession(req: SandboxExecRequest): Promise<SandboxExecResult> {
      const data = await postJson(
        "/sandbox/exec",
        {
          sandbox_id: req.sandboxId,
          command: req.command,
          timeout_ms: req.timeoutMs,
          env: req.env ?? null,
          stdin: req.stdin ?? null,
          cwd: req.cwd ?? null,
        },
        ModalExecResponseSchema,
        req.timeoutMs + 15_000,
      );
      return {
        exitCode: data.exit_code,
        stdout: data.stdout,
        stderr: data.stderr,
        durationMs: data.duration_ms,
        timedOut: data.timed_out,
        gone: data.gone,
        // null (old runner / uncapturable) collapses to undefined at the type
        // boundary so callers just see "no update" and keep the prior cwd.
        cwd: data.cwd ?? undefined,
      };
    },

    async snapshotSession(sandboxId: string): Promise<{ snapshotId: string }> {
      const data = await postJson(
        "/sandbox/snapshot",
        { sandbox_id: sandboxId },
        ModalSnapshotResponseSchema,
        300_000,
      );
      return { snapshotId: data.snapshot_id };
    },

    async restoreSession(
      snapshotId: string,
      spec: SandboxSessionSpec,
    ): Promise<SandboxSessionHandle> {
      const data = await postJson(
        "/sandbox/restore",
        { snapshot_id: snapshotId, ...sessionBody(spec) },
        ModalSessionHandleSchema,
        300_000,
      );
      return {
        sandboxId: data.sandbox_id,
        status: data.status,
        createdAt: data.created_at,
      };
    },

    async stopSession(sandboxId: string): Promise<void> {
      await postJson(
        "/sandbox/terminate",
        { sandbox_id: sandboxId },
        z.object({ ok: z.boolean() }),
        30_000,
      );
    },

    async sessionStatus(sandboxId: string): Promise<"running" | "gone"> {
      const data = await postJson(
        "/sandbox/status",
        { sandbox_id: sandboxId },
        ModalStatusResponseSchema,
        30_000,
      );
      return data.status;
    },
  };
}
