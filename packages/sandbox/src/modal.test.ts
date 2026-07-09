/**
 * Unit tests for the Modal sandbox driver.
 *
 * All tests use the ModalSandboxConfig.fetchImpl injection point so no
 * live HTTP calls are made. Covers:
 *
 *   - HTTP 200 success path (run returns correct SandboxResult shape)
 *   - HTTP 4xx/5xx error path (Error is thrown with status + body)
 *   - AbortController fires after timeoutMs + 15 s
 *   - stream() yields stdout then stderr as separate chunks
 *   - getSandbox() returns the modal driver when SANDBOX_DRIVER=modal
 *     and both env vars are set
 *   - getSandbox() throws when SANDBOX_DRIVER=modal but MODAL_RUNNER_URL
 *     or MODAL_RUNNER_TOKEN is missing
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createModalSandbox } from "./modal";
import { getSandbox, setSandboxForTests } from "./index";
import type {
  SandboxRequest,
  SandboxExecRequest,
  SandboxSessionSpec,
} from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    language: "node",
    code: 'console.log("hi")',
    timeoutMs: 5_000,
    memoryMb: 256,
    network: "deny",
    orgId: "org_test",
    workspaceId: "wrk_test",
    ...overrides,
  };
}

const BASE_CONFIG = {
  runnerUrl: "https://example.modal.run",
  runnerToken: "tok_test",
};

function makeSessionSpec(
  overrides: Partial<SandboxSessionSpec> = {},
): SandboxSessionSpec {
  return {
    image: "node",
    memoryMb: 512,
    ttlSeconds: 86_400,
    idleTimeoutSeconds: 300,
    network: "deny",
    orgId: "org_test",
    workspaceId: "wrk_test",
    ...overrides,
  };
}

function makeExecReq(
  overrides: Partial<SandboxExecRequest> = {},
): SandboxExecRequest {
  return {
    sandboxId: "sb-123",
    command: "echo hi",
    timeoutMs: 5_000,
    ...overrides,
  };
}

function makeFetch(
  status: number,
  body: unknown,
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// HTTP 200 — success path
// ---------------------------------------------------------------------------

describe("createModalSandbox — run() HTTP 200 success", () => {
  it("returns a SandboxResult with the runner's values", async () => {
    const responseBody = {
      exit_code: 0,
      stdout: "hello\n",
      stderr: "",
      duration_ms: 420,
      timed_out: false,
      oom_killed: false,
    };
    const driver = createModalSandbox({
      ...BASE_CONFIG,
      fetchImpl: makeFetch(200, responseBody),
    });

    const result = await driver.run(makeReq());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.durationMs).toBe(420);
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
  });

  it("passes language, code, timeoutMs, memoryMb, network, orgId, workspaceId to the runner", async () => {
    const fetchSpy = makeFetch(200, {
      exit_code: 0, stdout: "", stderr: "", duration_ms: 1, timed_out: false, oom_killed: false,
    });
    const driver = createModalSandbox({ ...BASE_CONFIG, fetchImpl: fetchSpy });

    await driver.run(makeReq({
      language: "python",
      code: "print('ok')",
      timeoutMs: 10_000,
      memoryMb: 512,
      network: "allow",
      orgId: "org_abc",
      workspaceId: "wrk_xyz",
    }));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.modal.run/run");
    const body = JSON.parse(init.body as string) as {
      language: string;
      code: string;
      timeout_ms: number;
      memory_mb: number;
      network: string;
      org_id: string;
      workspace_id: string;
    };
    expect(body.language).toBe("python");
    expect(body.code).toBe("print('ok')");
    expect(body.timeout_ms).toBe(10_000);
    expect(body.memory_mb).toBe(512);
    expect(body.network).toBe("allow");
    expect(body.org_id).toBe("org_abc");
    expect(body.workspace_id).toBe("wrk_xyz");
  });

  it("forwards the workspace files map to the runner", async () => {
    const fetchSpy = makeFetch(200, {
      exit_code: 0, stdout: "", stderr: "", duration_ms: 1, timed_out: false, oom_killed: false,
    });
    const driver = createModalSandbox({ ...BASE_CONFIG, fetchImpl: fetchSpy });

    await driver.run(makeReq({ files: { "util.js": "1", "src/a.js": "2" } }));

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { files?: Record<string, string> };
    expect(body.files).toEqual({ "util.js": "1", "src/a.js": "2" });
  });
});

// ---------------------------------------------------------------------------
// HTTP 4xx / 5xx — error path
// ---------------------------------------------------------------------------

describe("createModalSandbox — run() HTTP error", () => {
  it("throws an Error that includes the HTTP status on 4xx", async () => {
    const driver = createModalSandbox({
      ...BASE_CONFIG,
      fetchImpl: makeFetch(403, "Forbidden"),
    });

    await expect(driver.run(makeReq())).rejects.toThrow(/modal runner 403/);
  });

  it("throws an Error that includes the HTTP status on 5xx", async () => {
    const driver = createModalSandbox({
      ...BASE_CONFIG,
      fetchImpl: makeFetch(503, "Service Unavailable"),
    });

    await expect(driver.run(makeReq())).rejects.toThrow(/modal runner 503/);
  });

  it("includes (up to 500 chars of) the response body in the error", async () => {
    const detail = "container OOM at allocation";
    const driver = createModalSandbox({
      ...BASE_CONFIG,
      fetchImpl: makeFetch(500, detail),
    });

    await expect(driver.run(makeReq())).rejects.toThrow(detail);
  });
});

// ---------------------------------------------------------------------------
// AbortController — HTTP timeout
// ---------------------------------------------------------------------------

describe("createModalSandbox — AbortController timeout", () => {
  it("aborts the fetch after timeoutMs + 15 s", async () => {
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | undefined;
    const hangingFetch = vi.fn((_url: unknown, init: RequestInit) => {
      const sig = init.signal as AbortSignal;
      capturedSignal = sig;
      // Mirrors real fetch: reject with AbortError when the signal fires so
      // the run() promise settles (otherwise the test hangs waiting for it).
      return new Promise<Response>((_resolve, reject) => {
        sig.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const driver = createModalSandbox({ ...BASE_CONFIG, fetchImpl: hangingFetch });
    const req = makeReq({ timeoutMs: 5_000 });

    const runPromise = driver.run(req);
    // Attach rejection handler immediately so the promise is never unhandled.
    const rejectAssertion = expect(runPromise).rejects.toBeDefined();

    // Advance past the HTTP timeout (timeoutMs + 15_000 ms = 20_000 ms).
    await vi.advanceTimersByTimeAsync(20_001);

    expect(capturedSignal?.aborted).toBe(true);

    // Await the pre-attached rejection assertion.
    await rejectAssertion;

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// stream() — yields stdout then stderr
// ---------------------------------------------------------------------------

describe("createModalSandbox — stream()", () => {
  it("yields a stdout chunk then a stderr chunk when both are non-empty", async () => {
    const responseBody = {
      exit_code: 0,
      stdout: "out\n",
      stderr: "err\n",
      duration_ms: 100,
      timed_out: false,
      oom_killed: false,
    };
    const driver = createModalSandbox({
      ...BASE_CONFIG,
      fetchImpl: makeFetch(200, responseBody),
    });

    const chunks = [];
    for await (const chunk of driver.stream(makeReq())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ channel: "stdout", data: "out\n" });
    expect(chunks[1]).toMatchObject({ channel: "stderr", data: "err\n" });
  });

  it("yields only the stdout chunk when stderr is empty", async () => {
    const responseBody = {
      exit_code: 0,
      stdout: "only-stdout\n",
      stderr: "",
      duration_ms: 50,
      timed_out: false,
      oom_killed: false,
    };
    const driver = createModalSandbox({
      ...BASE_CONFIG,
      fetchImpl: makeFetch(200, responseBody),
    });

    const chunks = [];
    for await (const chunk of driver.stream(makeReq())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ channel: "stdout", data: "only-stdout\n" });
  });

  it("yields no chunks when both stdout and stderr are empty", async () => {
    const responseBody = {
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration_ms: 10,
      timed_out: false,
      oom_killed: false,
    };
    const driver = createModalSandbox({
      ...BASE_CONFIG,
      fetchImpl: makeFetch(200, responseBody),
    });

    const chunks = [];
    for await (const chunk of driver.stream(makeReq())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getSandbox() driver selection — modal branch
// ---------------------------------------------------------------------------

describe("getSandbox() with SANDBOX_DRIVER=modal", () => {
  const savedDriver = process.env.SANDBOX_DRIVER;
  const savedUrl = process.env.MODAL_RUNNER_URL;
  const savedToken = process.env.MODAL_RUNNER_TOKEN;

  beforeEach(() => {
    setSandboxForTests(null);
  });

  afterEach(() => {
    // Restore original env.
    if (savedDriver === undefined) {
      delete process.env.SANDBOX_DRIVER;
    } else {
      process.env.SANDBOX_DRIVER = savedDriver;
    }
    if (savedUrl === undefined) {
      delete process.env.MODAL_RUNNER_URL;
    } else {
      process.env.MODAL_RUNNER_URL = savedUrl;
    }
    if (savedToken === undefined) {
      delete process.env.MODAL_RUNNER_TOKEN;
    } else {
      process.env.MODAL_RUNNER_TOKEN = savedToken;
    }
    setSandboxForTests(null);
  });

  it("returns a driver with name === 'modal' when SANDBOX_DRIVER=modal and both env vars are set", () => {
    process.env.SANDBOX_DRIVER = "modal";
    process.env.MODAL_RUNNER_URL = "https://example.modal.run";
    process.env.MODAL_RUNNER_TOKEN = "tok_test";

    const driver = getSandbox();

    expect(driver.name).toBe("modal");
  });

  it("throws when SANDBOX_DRIVER=modal but MODAL_RUNNER_URL is missing", () => {
    process.env.SANDBOX_DRIVER = "modal";
    delete process.env.MODAL_RUNNER_URL;
    process.env.MODAL_RUNNER_TOKEN = "tok_test";

    expect(() => getSandbox()).toThrow(/MODAL_RUNNER_URL/);
  });

  it("throws when SANDBOX_DRIVER=modal but MODAL_RUNNER_TOKEN is missing", () => {
    process.env.SANDBOX_DRIVER = "modal";
    process.env.MODAL_RUNNER_URL = "https://example.modal.run";
    delete process.env.MODAL_RUNNER_TOKEN;

    expect(() => getSandbox()).toThrow(/MODAL_RUNNER_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// Durable sessions — create / exec / snapshot / restore / stop / status
// ---------------------------------------------------------------------------

// The driver's session methods are declared optional on SandboxDriver, but the
// Modal driver always implements them (supportsSessions === true), so narrow
// once here to keep the tests free of repeated existence guards.
type SessionDriver = ReturnType<typeof createModalSandbox> &
  Required<
    Pick<
      ReturnType<typeof createModalSandbox>,
      | "createSession"
      | "execInSession"
      | "snapshotSession"
      | "restoreSession"
      | "stopSession"
      | "sessionStatus"
    >
  >;

function makeSessionDriver(fetchImpl: typeof fetch): SessionDriver {
  return createModalSandbox({ ...BASE_CONFIG, fetchImpl }) as SessionDriver;
}

function lastCall(fetchSpy: typeof fetch): [string, RequestInit] {
  const calls = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}

describe("createModalSandbox — supportsSessions", () => {
  it("advertises durable-session support", () => {
    const driver = createModalSandbox(BASE_CONFIG);
    expect(driver.supportsSessions).toBe(true);
  });
});

describe("createModalSandbox — createSession()", () => {
  const handleBody = {
    sandbox_id: "sb-abc",
    status: "running" as const,
    created_at: "2026-07-02T00:00:00Z",
  };

  it("POSTs to /sandbox/create and maps the handle to camelCase", async () => {
    const fetchSpy = makeFetch(200, handleBody);
    const driver = makeSessionDriver(fetchSpy);

    const handle = await driver.createSession(makeSessionSpec());

    expect(handle).toEqual({
      sandboxId: "sb-abc",
      status: "running",
      createdAt: "2026-07-02T00:00:00Z",
    });
    const [url, init] = lastCall(fetchSpy);
    expect(url).toBe("https://example.modal.run/sandbox/create");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok_test",
    );
  });

  it("maps the session spec fields onto the snake_case runner body", async () => {
    const fetchSpy = makeFetch(200, handleBody);
    const driver = makeSessionDriver(fetchSpy);

    await driver.createSession(
      makeSessionSpec({
        image: "python",
        memoryMb: 1_024,
        ttlSeconds: 3_600,
        idleTimeoutSeconds: 120,
        network: "allow",
        orgId: "org_z",
        workspaceId: "wrk_z",
        setupCmd: "git clone repo",
      }),
    );

    const [, init] = lastCall(fetchSpy);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      image: "python",
      // Additive nullable template fields (imageRef / vcpu / diskMb) — null when
      // the session uses a base-kind image with no per-template resource
      // overrides, as this spec does.
      image_ref: null,
      memory_mb: 1_024,
      vcpu: null,
      disk_mb: null,
      ttl_seconds: 3_600,
      idle_timeout_seconds: 120,
      network: "allow",
      org_id: "org_z",
      workspace_id: "wrk_z",
      setup_cmd: "git clone repo",
    });
  });

  it("sends setup_cmd: null when no setupCmd is provided", async () => {
    const fetchSpy = makeFetch(200, handleBody);
    const driver = makeSessionDriver(fetchSpy);

    await driver.createSession(makeSessionSpec());

    const [, init] = lastCall(fetchSpy);
    const body = JSON.parse(init.body as string) as { setup_cmd: unknown };
    expect(body.setup_cmd).toBeNull();
  });

  it("throws with status + path + body when the runner returns an error", async () => {
    const driver = makeSessionDriver(makeFetch(500, "provision failed"));

    await expect(driver.createSession(makeSessionSpec())).rejects.toThrow(
      /modal runner 500 \/sandbox\/create: provision failed/,
    );
  });
});

describe("createModalSandbox — execInSession()", () => {
  const execBody = {
    exit_code: 2,
    stdout: "out",
    stderr: "err",
    duration_ms: 33,
    timed_out: false,
    gone: false,
  };

  it("POSTs to /sandbox/exec and maps the result to camelCase", async () => {
    const fetchSpy = makeFetch(200, execBody);
    const driver = makeSessionDriver(fetchSpy);

    const result = await driver.execInSession(makeExecReq());

    expect(result).toEqual({
      exitCode: 2,
      stdout: "out",
      stderr: "err",
      durationMs: 33,
      timedOut: false,
      gone: false,
    });
    const [url] = lastCall(fetchSpy);
    expect(url).toBe("https://example.modal.run/sandbox/exec");
  });

  it("forwards command, env and stdin on the request body", async () => {
    const fetchSpy = makeFetch(200, execBody);
    const driver = makeSessionDriver(fetchSpy);

    await driver.execInSession(
      makeExecReq({
        sandboxId: "sb-999",
        command: "pytest -q",
        env: { CI: "1" },
        stdin: "input\n",
      }),
    );

    const [, init] = lastCall(fetchSpy);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      sandbox_id: "sb-999",
      command: "pytest -q",
      timeout_ms: 5_000,
      env: { CI: "1" },
      stdin: "input\n",
    });
  });

  it("sends null env and stdin when omitted", async () => {
    const fetchSpy = makeFetch(200, execBody);
    const driver = makeSessionDriver(fetchSpy);

    await driver.execInSession(makeExecReq());

    const [, init] = lastCall(fetchSpy);
    const body = JSON.parse(init.body as string) as {
      env: unknown;
      stdin: unknown;
    };
    expect(body.env).toBeNull();
    expect(body.stdin).toBeNull();
  });

  it("surfaces gone: true when the runner reports the sandbox was reaped", async () => {
    const driver = makeSessionDriver(
      makeFetch(200, { ...execBody, gone: true }),
    );

    const result = await driver.execInSession(makeExecReq());

    expect(result.gone).toBe(true);
  });
});

describe("createModalSandbox — snapshotSession()", () => {
  it("POSTs the sandbox id and returns the snapshot id", async () => {
    const fetchSpy = makeFetch(200, { snapshot_id: "snap-1" });
    const driver = makeSessionDriver(fetchSpy);

    const result = await driver.snapshotSession("sb-abc");

    expect(result).toEqual({ snapshotId: "snap-1" });
    const [url, init] = lastCall(fetchSpy);
    expect(url).toBe("https://example.modal.run/sandbox/snapshot");
    const body = JSON.parse(init.body as string) as { sandbox_id: string };
    expect(body.sandbox_id).toBe("sb-abc");
  });
});

describe("createModalSandbox — restoreSession()", () => {
  const handleBody = {
    sandbox_id: "sb-restored",
    status: "running" as const,
    created_at: "2026-07-02T01:00:00Z",
  };

  it("POSTs the snapshot id alongside the session spec and maps the handle", async () => {
    const fetchSpy = makeFetch(200, handleBody);
    const driver = makeSessionDriver(fetchSpy);

    const handle = await driver.restoreSession("snap-9", makeSessionSpec());

    expect(handle).toEqual({
      sandboxId: "sb-restored",
      status: "running",
      createdAt: "2026-07-02T01:00:00Z",
    });
    const [url, init] = lastCall(fetchSpy);
    expect(url).toBe("https://example.modal.run/sandbox/restore");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.snapshot_id).toBe("snap-9");
    // Spreads the same snake_case session body as create.
    expect(body.image).toBe("node");
    expect(body.memory_mb).toBe(512);
  });
});

describe("createModalSandbox — stopSession()", () => {
  it("POSTs to /sandbox/terminate and resolves void", async () => {
    const fetchSpy = makeFetch(200, { ok: true });
    const driver = makeSessionDriver(fetchSpy);

    await expect(driver.stopSession("sb-abc")).resolves.toBeUndefined();
    const [url, init] = lastCall(fetchSpy);
    expect(url).toBe("https://example.modal.run/sandbox/terminate");
    const body = JSON.parse(init.body as string) as { sandbox_id: string };
    expect(body.sandbox_id).toBe("sb-abc");
  });

  it("throws when the runner rejects the terminate call", async () => {
    const driver = makeSessionDriver(makeFetch(404, "no such sandbox"));

    await expect(driver.stopSession("sb-gone")).rejects.toThrow(
      /modal runner 404 \/sandbox\/terminate/,
    );
  });
});

describe("createModalSandbox — sessionStatus()", () => {
  it("returns 'running' when the runner reports a live sandbox", async () => {
    const driver = makeSessionDriver(
      makeFetch(200, { sandbox_id: "sb-abc", status: "running" }),
    );

    await expect(driver.sessionStatus("sb-abc")).resolves.toBe("running");
  });

  it("returns 'gone' when the runner reports a reaped sandbox", async () => {
    const fetchSpy = makeFetch(200, { sandbox_id: "sb-abc", status: "gone" });
    const driver = makeSessionDriver(fetchSpy);

    await expect(driver.sessionStatus("sb-abc")).resolves.toBe("gone");
    const [url] = lastCall(fetchSpy);
    expect(url).toBe("https://example.modal.run/sandbox/status");
  });
});

describe("createModalSandbox — postJson error body handling", () => {
  it("tolerates a text() failure and still throws with the status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error("stream read failed")),
      json: () => Promise.resolve({}),
    }) as unknown as typeof fetch;
    const driver = makeSessionDriver(fetchImpl);

    await expect(driver.sessionStatus("sb-abc")).rejects.toThrow(
      /modal runner 502 \/sandbox\/status/,
    );
  });

  it("aborts the session request after the per-endpoint timeout budget", async () => {
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | undefined;
    const hangingFetch = vi.fn((_url: unknown, init: RequestInit) => {
      const sig = init.signal as AbortSignal;
      capturedSignal = sig;
      return new Promise<Response>((_resolve, reject) => {
        sig.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const driver = makeSessionDriver(hangingFetch);
    // sessionStatus uses a 30 s budget.
    const statusPromise = driver.sessionStatus("sb-abc");
    const rejectAssertion = expect(statusPromise).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(30_001);

    expect(capturedSignal?.aborted).toBe(true);
    await rejectAssertion;

    vi.useRealTimers();
  });
});
