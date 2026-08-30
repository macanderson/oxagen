/**
 * Unit tests for the Vercel Sandbox driver.
 *
 * These are purely unit tests — no live API calls to Vercel's infrastructure
 * are made. Tests cover construction, pure helper functions, and the driver
 * selection path in getSandbox(). SANDBOX_DRIVER is process.env-gated in
 * integration environments; set it in CI env to choose the appropriate driver.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import {
  createVercelSandbox,
  runtimeFor,
  networkPolicyFor,
  VercelSandboxUnsupportedError,
  type SandboxFactory,
} from "./vercel";
import { getSandbox, isSandboxAvailable, setSandboxForTests } from "./index";

// ---------------------------------------------------------------------------
// Driver construction
// ---------------------------------------------------------------------------

describe("createVercelSandbox — construction", () => {
  it("returns a driver with name === 'vercel' when given explicit credentials", () => {
    const driver = createVercelSandbox({
      token: "tok_test",
      teamId: "team_test",
      projectId: "prj_test",
    });
    expect(driver.name).toBe("vercel");
  });

  it("returns a driver (no throw) when constructed without credentials", () => {
    // Credentials are resolved lazily by the SDK via OIDC at the first API
    // call. Construction itself must not throw.
    const driver = createVercelSandbox({});
    expect(driver).toBeDefined();
    expect(driver.name).toBe("vercel");
  });

  it("exposes run, stream, and warmup methods", () => {
    const driver = createVercelSandbox({});
    expect(typeof driver.run).toBe("function");
    expect(typeof driver.stream).toBe("function");
    expect(typeof driver.warmup).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// runtimeFor — pure mapping helper
// ---------------------------------------------------------------------------

describe("runtimeFor", () => {
  it("maps 'node' to 'node24'", () => {
    expect(runtimeFor("node")).toBe("node24");
  });

  it("maps 'python' to 'python3.13'", () => {
    expect(runtimeFor("python")).toBe("python3.13");
  });

  it("maps 'shell' to 'node24' (shell runs via /bin/sh on the node24 runtime)", () => {
    expect(runtimeFor("shell")).toBe("node24");
  });
});

// ---------------------------------------------------------------------------
// networkPolicyFor — pure mapping helper
// ---------------------------------------------------------------------------

describe("networkPolicyFor", () => {
  it("maps 'deny' to the deny-all policy string", () => {
    expect(networkPolicyFor("deny")).toEqual("deny-all");
  });

  it("maps 'allow' to the allow-all policy string", () => {
    expect(networkPolicyFor("allow")).toEqual("allow-all");
  });
});

// ---------------------------------------------------------------------------
// VercelSandboxUnsupportedError
// ---------------------------------------------------------------------------

describe("VercelSandboxUnsupportedError", () => {
  it("is an instance of Error", () => {
    const err = new VercelSandboxUnsupportedError("test");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name VercelSandboxUnsupportedError", () => {
    const err = new VercelSandboxUnsupportedError("test");
    expect(err.name).toBe("VercelSandboxUnsupportedError");
  });

  it("preserves the message", () => {
    const err = new VercelSandboxUnsupportedError("stdin not supported");
    expect(err.message).toBe("stdin not supported");
  });
});

// ---------------------------------------------------------------------------
// getSandbox() driver selection — SANDBOX_DRIVER=vercel
// ---------------------------------------------------------------------------

describe("getSandbox() with SANDBOX_DRIVER=vercel", () => {
  const originalDriver = process.env.SANDBOX_DRIVER;

  beforeEach(() => {
    // Reset the singleton before each test so driver selection is re-evaluated.
    setSandboxForTests(null);
  });

  it("returns a driver with name === 'vercel' when SANDBOX_DRIVER=vercel", () => {
    process.env.SANDBOX_DRIVER = "vercel";
    try {
      const driver = getSandbox();
      expect(driver.name).toBe("vercel");
    } finally {
      if (originalDriver === undefined) {
        delete process.env.SANDBOX_DRIVER;
      } else {
        process.env.SANDBOX_DRIVER = originalDriver;
      }
      setSandboxForTests(null);
    }
  });

  it("the vercel driver is selected over modal even when MODAL_RUNNER_URL is set", () => {
    process.env.SANDBOX_DRIVER = "vercel";
    const originalModal = process.env.MODAL_RUNNER_URL;
    process.env.MODAL_RUNNER_URL = "https://example.modal.run";
    try {
      const driver = getSandbox();
      expect(driver.name).toBe("vercel");
    } finally {
      if (originalDriver === undefined) {
        delete process.env.SANDBOX_DRIVER;
      } else {
        process.env.SANDBOX_DRIVER = originalDriver;
      }
      if (originalModal === undefined) {
        delete process.env.MODAL_RUNNER_URL;
      } else {
        process.env.MODAL_RUNNER_URL = originalModal;
      }
      setSandboxForTests(null);
    }
  });
});

// ---------------------------------------------------------------------------
// getSandbox() — docker fallback branch
// ---------------------------------------------------------------------------

describe("getSandbox() docker fallback", () => {
  const originalDriver = process.env.SANDBOX_DRIVER;
  const originalUrl = process.env.MODAL_RUNNER_URL;
  const originalToken = process.env.MODAL_RUNNER_TOKEN;

  beforeEach(() => {
    setSandboxForTests(null);
  });

  afterEach(() => {
    if (originalDriver === undefined) {
      delete process.env.SANDBOX_DRIVER;
    } else {
      process.env.SANDBOX_DRIVER = originalDriver;
    }
    if (originalUrl === undefined) {
      delete process.env.MODAL_RUNNER_URL;
    } else {
      process.env.MODAL_RUNNER_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.MODAL_RUNNER_TOKEN;
    } else {
      process.env.MODAL_RUNNER_TOKEN = originalToken;
    }
    setSandboxForTests(null);
  });

  it("returns a docker driver when SANDBOX_DRIVER is unset and MODAL_RUNNER_URL is absent", () => {
    delete process.env.SANDBOX_DRIVER;
    delete process.env.MODAL_RUNNER_URL;
    delete process.env.MODAL_RUNNER_TOKEN;

    const driver = getSandbox();

    expect(driver.name).toBe("docker");
  });

  it("returns a docker driver when SANDBOX_DRIVER is unset and only MODAL_RUNNER_URL is set (no token)", () => {
    delete process.env.SANDBOX_DRIVER;
    process.env.MODAL_RUNNER_URL = "https://example.modal.run";
    delete process.env.MODAL_RUNNER_TOKEN;

    // Auto-detect requires BOTH URL and TOKEN; missing token falls through to docker.
    const driver = getSandbox();

    expect(driver.name).toBe("docker");
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
// isSandboxAvailable — single source of truth for GAP-5
// ---------------------------------------------------------------------------

describe("isSandboxAvailable", () => {
  // Capture originals once; restore after each test.
  const origEnabled = process.env.SANDBOX_ENABLED;
  const origDriver = process.env.SANDBOX_DRIVER;
  const origModalUrl = process.env.MODAL_RUNNER_URL;
  const origModalToken = process.env.MODAL_RUNNER_TOKEN;

  afterEach(() => {
    if (origEnabled === undefined) delete process.env.SANDBOX_ENABLED;
    else process.env.SANDBOX_ENABLED = origEnabled;
    if (origDriver === undefined) delete process.env.SANDBOX_DRIVER;
    else process.env.SANDBOX_DRIVER = origDriver;
    if (origModalUrl === undefined) delete process.env.MODAL_RUNNER_URL;
    else process.env.MODAL_RUNNER_URL = origModalUrl;
    if (origModalToken === undefined) delete process.env.MODAL_RUNNER_TOKEN;
    else process.env.MODAL_RUNNER_TOKEN = origModalToken;
  });

  it("returns false when SANDBOX_ENABLED is unset", () => {
    delete process.env.SANDBOX_ENABLED;
    delete process.env.SANDBOX_DRIVER;
    expect(isSandboxAvailable()).toBe(false);
  });

  it("returns false when SANDBOX_ENABLED=false", () => {
    process.env.SANDBOX_ENABLED = "false";
    delete process.env.SANDBOX_DRIVER;
    expect(isSandboxAvailable()).toBe(false);
  });

  it("returns true when SANDBOX_ENABLED=true and SANDBOX_DRIVER=vercel", () => {
    process.env.SANDBOX_ENABLED = "true";
    process.env.SANDBOX_DRIVER = "vercel";
    expect(isSandboxAvailable()).toBe(true);
  });

  it("returns true when SANDBOX_ENABLED=true and SANDBOX_DRIVER=docker", () => {
    process.env.SANDBOX_ENABLED = "true";
    process.env.SANDBOX_DRIVER = "docker";
    expect(isSandboxAvailable()).toBe(true);
  });

  it("returns true when SANDBOX_ENABLED=true and SANDBOX_DRIVER=modal with both URL+token set", () => {
    process.env.SANDBOX_ENABLED = "true";
    process.env.SANDBOX_DRIVER = "modal";
    process.env.MODAL_RUNNER_URL = "https://example.modal.run";
    process.env.MODAL_RUNNER_TOKEN = "tok_test";
    expect(isSandboxAvailable()).toBe(true);
  });

  it("returns false when SANDBOX_ENABLED=true and SANDBOX_DRIVER=modal but URL is missing", () => {
    process.env.SANDBOX_ENABLED = "true";
    process.env.SANDBOX_DRIVER = "modal";
    delete process.env.MODAL_RUNNER_URL;
    process.env.MODAL_RUNNER_TOKEN = "tok_test";
    expect(isSandboxAvailable()).toBe(false);
  });

  it("returns false when SANDBOX_ENABLED=true and SANDBOX_DRIVER=modal but token is missing", () => {
    process.env.SANDBOX_ENABLED = "true";
    process.env.SANDBOX_DRIVER = "modal";
    process.env.MODAL_RUNNER_URL = "https://example.modal.run";
    delete process.env.MODAL_RUNNER_TOKEN;
    expect(isSandboxAvailable()).toBe(false);
  });

  it("returns true when SANDBOX_ENABLED=true and no explicit driver (docker auto-fallback)", () => {
    process.env.SANDBOX_ENABLED = "true";
    delete process.env.SANDBOX_DRIVER;
    delete process.env.MODAL_RUNNER_URL;
    delete process.env.MODAL_RUNNER_TOKEN;
    expect(isSandboxAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sandbox mock helpers
// ---------------------------------------------------------------------------

interface MockCommandFinished {
  exitCode: number;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
}

interface MockCommand {
  logs: () => AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
}

interface MockSandboxInstance {
  fs: { writeFile: ReturnType<typeof vi.fn> };
  runCommand: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeFinished(
  stdout: string,
  stderr: string,
  exitCode = 0,
): MockCommandFinished {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

function makeMockSandboxImpl(instance: MockSandboxInstance): SandboxFactory {
  return {
    create: vi.fn().mockResolvedValue(instance) as SandboxFactory["create"],
  };
}

function makeVercelReq(
  overrides: Partial<Parameters<typeof createVercelSandbox>[0]> = {},
) {
  void overrides;
  return {
    language: "node" as const,
    code: 'console.log("hi")',
    timeoutMs: 10_000,
    memoryMb: 256,
    network: "deny" as const,
    orgId: "org_test",
    workspaceId: "wrk_test",
  };
}

// ---------------------------------------------------------------------------
// createVercelSandbox — run()
// ---------------------------------------------------------------------------

describe("createVercelSandbox — run()", () => {
  it("returns stdout and exit code 0 for a normal run", async () => {
    const finished = makeFinished("hello\n", "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const sandboxImpl = makeMockSandboxImpl(instance);
    const driver = createVercelSandbox({}, sandboxImpl);

    const result = await driver.run(makeVercelReq());

    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
  });

  it("writes extra workspace files next to the entrypoint", async () => {
    const finished = makeFinished("ok\n", "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createVercelSandbox({}, makeMockSandboxImpl(instance));

    await driver.run({
      ...makeVercelReq(),
      files: { "util.js": "module.exports = 1", "lib/a.js": "1" },
    });

    // Entrypoint at /work/main.js, so extra files land under /work/.
    expect(instance.fs.writeFile).toHaveBeenCalledWith(
      "/work/main.js",
      expect.any(String),
      "utf8",
    );
    expect(instance.fs.writeFile).toHaveBeenCalledWith(
      "/work/util.js",
      "module.exports = 1",
      "utf8",
    );
    expect(instance.fs.writeFile).toHaveBeenCalledWith(
      "/work/lib/a.js",
      "1",
      "utf8",
    );
  });

  it("returns stderr from a failed command", async () => {
    const finished = makeFinished("", "error output\n", 1);
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createVercelSandbox({}, makeMockSandboxImpl(instance));

    const result = await driver.run(makeVercelReq());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error output\n");
  });

  it("throws VercelSandboxUnsupportedError when stdin is provided to run()", async () => {
    const driver = createVercelSandbox({});

    await expect(
      driver.run({ ...makeVercelReq(), stdin: "some input" }),
    ).rejects.toThrow(VercelSandboxUnsupportedError);
  });

  it("calls sandbox.stop() even when runCommand throws", async () => {
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockRejectedValue(new Error("exec failed")),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createVercelSandbox({}, makeMockSandboxImpl(instance));

    await expect(driver.run(makeVercelReq())).rejects.toThrow("exec failed");
    expect(instance.stop).toHaveBeenCalled();
  });

  it("truncates stdout when it exceeds 8 MB", async () => {
    const bigOutput = "x".repeat(8 * 1024 * 1024 + 100);
    const finished = makeFinished(bigOutput, "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createVercelSandbox({}, makeMockSandboxImpl(instance));

    const result = await driver.run(makeVercelReq());

    expect(result.stdout).toContain("[output truncated");
    expect(result.stdout.length).toBeLessThan(bigOutput.length);
  });

  it("passes explicit credentials to sandbox.create when all three are set", async () => {
    const finished = makeFinished("", "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createFn: Mock = vi.fn().mockResolvedValue(instance);
    const driver = createVercelSandbox(
      { token: "tok", teamId: "team", projectId: "prj" },
      { create: createFn as unknown as SandboxFactory["create"] },
    );

    await driver.run(makeVercelReq());

    const call = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.token).toBe("tok");
    expect(call?.teamId).toBe("team");
    expect(call?.projectId).toBe("prj");
  });

  it("uses shell runtime and /tmp/main.sh path for shell language", async () => {
    const finished = makeFinished("ok", "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createFn: Mock = vi.fn().mockResolvedValue(instance);
    const driver = createVercelSandbox(
      {},
      { create: createFn as unknown as SandboxFactory["create"] },
    );

    await driver.run({ ...makeVercelReq(), language: "shell" });

    const createParams = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createParams?.runtime).toBe("node24");
    const writeFileCall = instance.fs.writeFile.mock.calls[0] as
      | [string, string, string]
      | undefined;
    expect(writeFileCall?.[0]).toBe("/tmp/main.sh");
    const runCall = instance.runCommand.mock.calls[0]?.[0] as
      | { cmd: string; args: string[] }
      | undefined;
    expect(runCall?.cmd).toBe("/bin/sh");
    expect(runCall?.args).toContain("/tmp/main.sh");
  });

  it("uses python3.13 runtime for python language", async () => {
    const finished = makeFinished("", "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createFn: Mock = vi.fn().mockResolvedValue(instance);
    const driver = createVercelSandbox(
      {},
      { create: createFn as unknown as SandboxFactory["create"] },
    );

    await driver.run({ ...makeVercelReq(), language: "python" });

    const createParams = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createParams?.runtime).toBe("python3.13");
  });
});

// ---------------------------------------------------------------------------
// createVercelSandbox — stream()
// ---------------------------------------------------------------------------

async function* makeLogIterable(
  items: Array<{ stream: "stdout" | "stderr"; data: string }>,
): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }> {
  for (const item of items) {
    yield item;
  }
}

describe("createVercelSandbox — stream()", () => {
  it("yields stdout and stderr chunks", async () => {
    const logs = [
      { stream: "stdout" as const, data: "out1\n" },
      { stream: "stderr" as const, data: "err1\n" },
    ];
    const mockCommand: MockCommand = {
      logs: () => makeLogIterable(logs),
    };
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(mockCommand),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createVercelSandbox({}, makeMockSandboxImpl(instance));

    const chunks: Array<{ channel: string; data: string }> = [];
    for await (const chunk of driver.stream(makeVercelReq())) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({ channel: "stdout", data: "out1\n" }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ channel: "stderr", data: "err1\n" }),
    );
  });

  it("throws VercelSandboxUnsupportedError when stdin is provided to stream()", async () => {
    const driver = createVercelSandbox({});

    const iter = driver.stream({ ...makeVercelReq(), stdin: "data" });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
      VercelSandboxUnsupportedError,
    );
  });

  it("truncates stream output when accumulated bytes exceed 8 MB", async () => {
    const bigChunk = "x".repeat(8 * 1024 * 1024 + 100);
    const logs = [
      { stream: "stdout" as const, data: bigChunk },
      { stream: "stdout" as const, data: "should not appear\n" },
    ];
    const mockCommand: MockCommand = {
      logs: () => makeLogIterable(logs),
    };
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(mockCommand),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createVercelSandbox({}, makeMockSandboxImpl(instance));

    const chunks: Array<{ data: string }> = [];
    for await (const chunk of driver.stream(makeVercelReq())) {
      chunks.push(chunk);
    }

    const allData = chunks.map((c) => c.data).join("");
    expect(allData).toContain("[output truncated");
    expect(allData).not.toContain("should not appear");
  });

  it("calls sandbox.stop() in the finally block after streaming", async () => {
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi
        .fn()
        .mockResolvedValue({ logs: () => makeLogIterable([]) }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const driver = createVercelSandbox({}, makeMockSandboxImpl(instance));

    for await (const _chunk of driver.stream(makeVercelReq())) {
      // drain
    }

    expect(instance.stop).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createVercelSandbox — warmup()
// ---------------------------------------------------------------------------

describe("createVercelSandbox — warmup()", () => {
  it("resolves immediately without making any API calls (Vercel handles pooling)", async () => {
    const driver = createVercelSandbox({});
    await expect(driver.warmup?.()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Template runtime/resources — custom image is unsupported; vcpu maps to vcpus
// ---------------------------------------------------------------------------

describe("createVercelSandbox — template image/resources", () => {
  it("run() throws a clear error when a custom imageRef is set (fixed runtimes)", async () => {
    const driver = createVercelSandbox({});
    await expect(
      driver.run({ ...makeVercelReq(), imageRef: "ghcr.io/acme/x@sha256:1" }),
    ).rejects.toThrow(VercelSandboxUnsupportedError);
  });

  it("stream() throws a clear error when a custom imageRef is set", async () => {
    const driver = createVercelSandbox({});
    const iter = driver.stream({
      ...makeVercelReq(),
      imageRef: "ghcr.io/acme/x@sha256:1",
    });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
      VercelSandboxUnsupportedError,
    );
  });

  it("maps vcpu to resources.vcpus, clamped to the ceiling of 4", async () => {
    const finished = makeFinished("", "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createFn: Mock = vi.fn().mockResolvedValue(instance);
    const driver = createVercelSandbox(
      {},
      { create: createFn as unknown as SandboxFactory["create"] },
    );

    await driver.run({ ...makeVercelReq(), vcpu: 9 });

    const params = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.resources).toEqual({ vcpus: 4 });
  });

  it("defaults resources.vcpus to 1 when vcpu is unset", async () => {
    const finished = makeFinished("", "");
    const instance: MockSandboxInstance = {
      fs: { writeFile: vi.fn().mockResolvedValue(undefined) },
      runCommand: vi.fn().mockResolvedValue(finished),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createFn: Mock = vi.fn().mockResolvedValue(instance);
    const driver = createVercelSandbox(
      {},
      { create: createFn as unknown as SandboxFactory["create"] },
    );

    await driver.run(makeVercelReq());

    const params = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.resources).toEqual({ vcpus: 1 });
  });
});

// ---------------------------------------------------------------------------
// getSandbox(provider) — per-run provider override
// ---------------------------------------------------------------------------

describe("getSandbox(provider) — per-run provider override", () => {
  const origDriver = process.env.SANDBOX_DRIVER;
  const origUrl = process.env.MODAL_RUNNER_URL;
  const origToken = process.env.MODAL_RUNNER_TOKEN;

  beforeEach(() => setSandboxForTests(null));

  afterEach(() => {
    if (origDriver === undefined) delete process.env.SANDBOX_DRIVER;
    else process.env.SANDBOX_DRIVER = origDriver;
    if (origUrl === undefined) delete process.env.MODAL_RUNNER_URL;
    else process.env.MODAL_RUNNER_URL = origUrl;
    if (origToken === undefined) delete process.env.MODAL_RUNNER_TOKEN;
    else process.env.MODAL_RUNNER_TOKEN = origToken;
    setSandboxForTests(null);
  });

  it("selects vercel when provider='vercel' regardless of SANDBOX_DRIVER", () => {
    process.env.SANDBOX_DRIVER = "docker";
    expect(getSandbox("vercel").name).toBe("vercel");
  });

  it("selects docker when provider='docker' even with modal creds present", () => {
    process.env.SANDBOX_DRIVER = "modal";
    process.env.MODAL_RUNNER_URL = "https://example.modal.run";
    process.env.MODAL_RUNNER_TOKEN = "tok_test";
    expect(getSandbox("docker").name).toBe("docker");
  });

  it("throws for provider='modal' when runner creds are missing — no silent fallback", () => {
    delete process.env.MODAL_RUNNER_URL;
    delete process.env.MODAL_RUNNER_TOKEN;
    expect(() => getSandbox("modal")).toThrow(/MODAL_RUNNER_URL/);
  });

  it("throws for an unknown provider name", () => {
    expect(() => getSandbox("fly")).toThrow(/unknown provider/);
  });

  it("no-arg getSandbox still honors SANDBOX_DRIVER as the default", () => {
    process.env.SANDBOX_DRIVER = "docker";
    expect(getSandbox().name).toBe("docker");
  });
});
