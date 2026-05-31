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
import { createModalSandbox } from "./modal.js";
import { getSandbox, setSandboxForTests } from "./index.js";
import type { SandboxRequest } from "./types.js";

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
