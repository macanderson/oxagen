/**
 * Unit tests for Docker hostConfig security invariants.
 *
 * `hostConfigFor` assembles the Docker HostConfig that determines the
 * security posture of every sandbox container. These tests assert the
 * hardened properties that must be present regardless of the request:
 *
 *   - `no-new-privileges` in SecurityOpt  — prevents privilege escalation
 *     via setuid binaries or capabilities granted after exec.
 *   - `seccomp=builtin` in SecurityOpt    — applies Docker's default syscall
 *     filter; blocks dangerous calls (ptrace, mount, etc.) without a custom
 *     profile.
 *   - NetworkMode=none when network=deny  — no interface, no egress.
 *   - NetworkMode=bridge when network=allow
 *   - ReadonlyRootfs=true                 — container filesystem is immutable;
 *     writes only land in the tmpfs mounts.
 *   - Tmpfs has /work and /tmp             — the only writable paths.
 *   - CapDrop=["ALL"]                      — all Linux capabilities dropped.
 *
 * hostConfigFor is a pure function (no I/O); tests run without Docker.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import { hostConfigFor, createDockerSandbox } from "./docker";
import type { SandboxRequest } from "./types";
import type { ImageSpec } from "./images";
import type Dockerode from "dockerode";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    language: "node",
    code: 'console.log("hi")',
    timeoutMs: 10_000,
    memoryMb: 256,
    network: "deny",
    orgId: "org_test",
    workspaceId: "wrk_test",
    ...overrides,
  };
}

const TEST_SPEC: ImageSpec = {
  image: "node@sha256:abc123",
  entrypoint: ["node", "/work/main.js"],
  codePath: "/work/main.js",
  tmpfsBytes: 64 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// SecurityOpt invariants
// ---------------------------------------------------------------------------

describe("hostConfigFor — SecurityOpt", () => {
  it("includes no-new-privileges", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.SecurityOpt).toContain("no-new-privileges");
  });

  it("includes seccomp=builtin", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.SecurityOpt).toContain("seccomp=builtin");
  });

  it("does not include seccomp=unconfined", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.SecurityOpt).not.toContain("seccomp=unconfined");
  });

  it("has both security options regardless of network setting", () => {
    const denyReq = makeReq({ network: "deny" });
    const allowReq = makeReq({ network: "allow" });
    for (const req of [denyReq, allowReq]) {
      const cfg = hostConfigFor(req, TEST_SPEC);
      expect(cfg.SecurityOpt).toContain("no-new-privileges");
      expect(cfg.SecurityOpt).toContain("seccomp=builtin");
    }
  });
});

// ---------------------------------------------------------------------------
// Network isolation
// ---------------------------------------------------------------------------

describe("hostConfigFor — network isolation", () => {
  it("sets NetworkMode=none when network=deny", () => {
    const cfg = hostConfigFor(makeReq({ network: "deny" }), TEST_SPEC);
    expect(cfg.NetworkMode).toBe("none");
  });

  it("sets NetworkMode=bridge when network=allow", () => {
    const cfg = hostConfigFor(makeReq({ network: "allow" }), TEST_SPEC);
    expect(cfg.NetworkMode).toBe("bridge");
  });
});

// ---------------------------------------------------------------------------
// Read-only root filesystem
// ---------------------------------------------------------------------------

describe("hostConfigFor — ReadonlyRootfs", () => {
  it("sets ReadonlyRootfs=true", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.ReadonlyRootfs).toBe(true);
  });

  it("ReadonlyRootfs is true regardless of network mode", () => {
    expect(
      hostConfigFor(makeReq({ network: "deny" }), TEST_SPEC).ReadonlyRootfs,
    ).toBe(true);
    expect(
      hostConfigFor(makeReq({ network: "allow" }), TEST_SPEC).ReadonlyRootfs,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tmpfs mounts
// ---------------------------------------------------------------------------

describe("hostConfigFor — tmpfs mounts", () => {
  it("mounts /work as a writable tmpfs", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.Tmpfs).toBeDefined();
    expect(cfg.Tmpfs).toHaveProperty("/work");
  });

  it("mounts /tmp as a writable tmpfs", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.Tmpfs).toHaveProperty("/tmp");
  });

  it("/work tmpfs size reflects the spec's tmpfsBytes", () => {
    const spec: ImageSpec = { ...TEST_SPEC, tmpfsBytes: 16 * 1024 * 1024 };
    const cfg = hostConfigFor(makeReq(), spec);
    // The mount option string contains the size value.
    const workMount = (cfg.Tmpfs as Record<string, string>)["/work"];
    expect(workMount).toContain(`${16 * 1024 * 1024}`);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("hostConfigFor — capability drop", () => {
  it("drops ALL capabilities", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.CapDrop).toEqual(["ALL"]);
  });
});

// ---------------------------------------------------------------------------
// Memory limits
// ---------------------------------------------------------------------------

describe("hostConfigFor — memory", () => {
  it("converts memoryMb to bytes for the Memory field", () => {
    const cfg = hostConfigFor(makeReq({ memoryMb: 256 }), TEST_SPEC);
    expect(cfg.Memory).toBe(256 * 1024 * 1024);
  });

  it("sets MemorySwap equal to Memory (disables swap)", () => {
    const cfg = hostConfigFor(makeReq({ memoryMb: 128 }), TEST_SPEC);
    expect(cfg.MemorySwap).toBe(cfg.Memory);
  });

  it("enforces a positive memory floor when memoryMb is 0 (Docker treats 0 as unlimited)", () => {
    const cfg = hostConfigFor(makeReq({ memoryMb: 0 }), TEST_SPEC);
    expect(cfg.Memory).toBe(16 * 1024 * 1024);
    expect(cfg.MemorySwap).toBe(cfg.Memory);
  });

  it("clamps a sub-floor memoryMb up to the 16 MB minimum", () => {
    const cfg = hostConfigFor(makeReq({ memoryMb: 4 }), TEST_SPEC);
    expect(cfg.Memory).toBe(16 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Helpers for Docker driver run/stream tests
// ---------------------------------------------------------------------------

/** Build a Docker multiplexed stream frame (8-byte header + payload). */
function dockerFrame(channel: 1 | 2, data: string): Buffer {
  const payload = Buffer.from(data, "utf8");
  const hdr = Buffer.alloc(8);
  hdr[0] = channel;
  hdr.writeUInt32BE(payload.length, 4);
  return Buffer.concat([hdr, payload]);
}

interface MockContainer {
  putArchive: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
}

function makeMockDockerSetup(): {
  docker: Dockerode;
  container: MockContainer;
  attachEmitter: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
} {
  const attachEmitter = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  }) as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };

  const container: MockContainer = {
    putArchive: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockResolvedValue(attachEmitter),
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    kill: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({ State: { OOMKilled: false } }),
  };

  const docker = {
    listImages: vi.fn().mockResolvedValue([{ Id: "sha256:cached" }]),
    createContainer: vi.fn().mockResolvedValue(container),
    pull: vi.fn(),
    modem: {
      followProgress: vi.fn((_s: unknown, cb: (e: Error | null) => void) =>
        cb(null),
      ),
      demuxStream: vi.fn(),
    },
  } as unknown as Dockerode;

  return { docker, container, attachEmitter };
}

// ---------------------------------------------------------------------------
// createDockerSandbox — run()
// ---------------------------------------------------------------------------

describe("createDockerSandbox — run()", () => {
  it("returns stdout and exit code 0 for a normal run", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => {
        attachEmitter.emit("data", dockerFrame(1, "hello\n"));
        attachEmitter.emit("end");
      });
    });

    const sandbox = createDockerSandbox(() => docker);
    const result = await sandbox.run(makeReq({ code: 'console.log("hello")' }));

    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
  });

  it("packs extra workspace files (and their parent dirs) into the /work archive", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();
    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => {
        attachEmitter.emit("data", dockerFrame(1, "ok\n"));
        attachEmitter.emit("end");
      });
    });

    const sandbox = createDockerSandbox(() => docker);
    await sandbox.run(
      makeReq({
        code: "require('./util')",
        files: { "util.js": "module.exports = 1", "src/lib.js": "1" },
      }),
    );

    expect(container.putArchive).toHaveBeenCalledTimes(1);
    const archive = container.putArchive.mock.calls[0]![0] as Buffer;
    const asText = archive.toString("latin1");
    // tar headers store entry names as plaintext; the entrypoint and every extra
    // file (plus the implied `src` directory) must be present in the archive.
    expect(asText).toContain("main.js");
    expect(asText).toContain("util.js");
    expect(asText).toContain("src/lib.js");
    expect(asText).toContain("src/");
  });

  it("does not hang when the stream 'end' fires before container.wait() resolves", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    // Emit data + "end" eagerly during start(), then resolve wait() on a
    // LATER macrotask. This reproduces the real-Docker race where stream EOF
    // precedes container exit. If the "end" listener were registered only
    // after the wait/timeout race (the previous behaviour), this emit would be
    // missed and run() would hang forever. The listener is now registered
    // before start(), so the run resolves.
    container.start = vi.fn().mockImplementation(async () => {
      attachEmitter.emit("data", dockerFrame(1, "fast\n"));
      attachEmitter.emit("end");
    });
    container.wait = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<{ StatusCode: number }>((r) =>
            setTimeout(() => r({ StatusCode: 0 }), 5),
          ),
      );

    const sandbox = createDockerSandbox(() => docker);
    const result = await sandbox.run(makeReq());

    expect(result.stdout).toBe("fast\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  }, 5_000);

  it("returns stderr output when container writes to stderr", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => {
        attachEmitter.emit("data", dockerFrame(2, "error message\n"));
        attachEmitter.emit("end");
      });
    });

    const sandbox = createDockerSandbox(() => docker);
    const result = await sandbox.run(makeReq());

    expect(result.stderr).toBe("error message\n");
    expect(result.exitCode).toBe(0);
  });

  it("reports non-zero exit code from container", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.wait = vi.fn().mockResolvedValue({ StatusCode: 1 });
    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => {
        attachEmitter.emit("data", dockerFrame(2, "fail\n"));
        attachEmitter.emit("end");
      });
    });

    const sandbox = createDockerSandbox(() => docker);
    const result = await sandbox.run(makeReq());

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it("sets timedOut=true and exitCode=137 when the container times out", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    // wait() never resolves — only the timer fires.
    container.wait = vi.fn().mockReturnValue(new Promise(() => undefined));
    container.start = vi.fn().mockResolvedValue(undefined);
    // Emit "end" only when kill() is called so the stream-end listener
    // is already registered (it's registered after the timeout fires).
    container.kill = vi.fn().mockImplementation(async () => {
      setImmediate(() => attachEmitter.emit("end"));
    });

    const sandbox = createDockerSandbox(() => docker);
    // Give extra vitest timeout since a real 50ms timer is involved.
    const result = await sandbox.run(makeReq({ timeoutMs: 50 }));

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(137);
    expect(container.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
  }, 10_000);

  it("sets oomKilled=true when container inspect reports OOMKilled", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.inspect = vi
      .fn()
      .mockResolvedValue({ State: { OOMKilled: true } });
    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => attachEmitter.emit("end"));
    });

    const sandbox = createDockerSandbox(() => docker);
    const result = await sandbox.run(makeReq());

    expect(result.oomKilled).toBe(true);
  });

  it("writes stdin to the attach stream when req.stdin is provided", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => attachEmitter.emit("end"));
    });

    const sandbox = createDockerSandbox(() => docker);
    await sandbox.run(makeReq({ stdin: "input data\n" }));

    expect(attachEmitter.write).toHaveBeenCalledWith("input data\n");
    expect(attachEmitter.end).toHaveBeenCalled();
  });

  it("truncates output and kills container when output exceeds 8 MB", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.start = vi.fn().mockImplementation(async () => {
      // Emit a frame just over the 8 MB limit
      const bigData = "x".repeat(8 * 1024 * 1024 + 1);
      const payload = Buffer.from(bigData, "utf8");
      const hdr = Buffer.alloc(8);
      hdr[0] = 1;
      hdr.writeUInt32BE(payload.length, 4);
      attachEmitter.emit("data", Buffer.concat([hdr, payload]));
      setImmediate(() => attachEmitter.emit("end"));
    });

    const sandbox = createDockerSandbox(() => docker);
    const result = await sandbox.run(makeReq());

    expect(result.stdout).toContain("[output truncated");
    expect(container.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
  });

  it("passes stdin attachment flags when req.stdin is set", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => attachEmitter.emit("end"));
    });

    const sandbox = createDockerSandbox(() => docker);
    await sandbox.run(makeReq({ stdin: "test" }));

    const attachCall = container.attach.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(attachCall.stdin).toBe(true);
  });

  it("pulls image when it is not cached", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    const mockPullStream = new EventEmitter();
    (docker as unknown as { listImages: ReturnType<typeof vi.fn> }).listImages =
      vi.fn().mockResolvedValue([]);
    (docker as unknown as { pull: ReturnType<typeof vi.fn> }).pull = vi
      .fn()
      .mockImplementation(
        (
          _image: string,
          _opts: unknown,
          cb: (err: null, stream: EventEmitter) => void,
        ) => {
          cb(null, mockPullStream);
        },
      );
    (
      docker as unknown as {
        modem: {
          followProgress: ReturnType<typeof vi.fn>;
          demuxStream: ReturnType<typeof vi.fn>;
        };
      }
    ).modem.followProgress = vi.fn(
      (_s: unknown, cb: (e: Error | null) => void) => cb(null),
    );

    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => attachEmitter.emit("end"));
    });

    const sandbox = createDockerSandbox(() => docker);
    await sandbox.run(makeReq());

    expect(
      (docker as unknown as { pull: ReturnType<typeof vi.fn> }).pull,
    ).toHaveBeenCalled();
  });

  it("includes env vars in the container create call", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();

    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => attachEmitter.emit("end"));
    });

    const sandbox = createDockerSandbox(() => docker);
    await sandbox.run(makeReq({ env: { FOO: "bar", BAZ: "qux" } }));

    const createCall = (
      docker as unknown as { createContainer: ReturnType<typeof vi.fn> }
    ).createContainer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createCall.Env).toContain("FOO=bar");
    expect(createCall.Env).toContain("BAZ=qux");
  });
});

// ---------------------------------------------------------------------------
// createDockerSandbox — stream()
// ---------------------------------------------------------------------------

describe("createDockerSandbox — stream()", () => {
  it("yields stdout and stderr chunks from the container", async () => {
    const { docker, container } = makeMockDockerSetup();
    const attachEmitter = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    attachEmitter.write = vi.fn();
    attachEmitter.end = vi.fn();

    container.attach = vi.fn().mockResolvedValue(attachEmitter);

    (
      docker as unknown as {
        modem: {
          demuxStream: ReturnType<typeof vi.fn>;
          followProgress: ReturnType<typeof vi.fn>;
        };
      }
    ).modem.demuxStream = vi.fn(
      (
        _attached: unknown,
        stdoutPipe: PassThrough,
        stderrPipe: PassThrough,
      ) => {
        setImmediate(() => {
          stdoutPipe.write(Buffer.from("out1\n"));
          stderrPipe.write(Buffer.from("err1\n"));
          stdoutPipe.end();
          stderrPipe.end();
        });
      },
    );

    // wait() resolves after a tick so the stream loop can finish
    container.wait = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<{ StatusCode: number }>((r) =>
            setImmediate(() => r({ StatusCode: 0 })),
          ),
      );
    container.start = vi.fn().mockResolvedValue(undefined);

    const sandbox = createDockerSandbox(() => docker);
    const chunks: Array<{ channel: string; data: string }> = [];
    for await (const chunk of sandbox.stream(makeReq())) {
      chunks.push(chunk);
    }

    const stdoutChunks = chunks.filter((c) => c.channel === "stdout");
    const stderrChunks = chunks.filter((c) => c.channel === "stderr");
    expect(stdoutChunks.some((c) => c.data === "out1\n")).toBe(true);
    expect(stderrChunks.some((c) => c.data === "err1\n")).toBe(true);
  });

  it("kills container when queue exceeds MAX_QUEUE_ITEMS (1000)", async () => {
    const { docker, container } = makeMockDockerSetup();
    const attachEmitter = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    attachEmitter.write = vi.fn();
    attachEmitter.end = vi.fn();

    container.attach = vi.fn().mockResolvedValue(attachEmitter);

    let capturedStdout: PassThrough | null = null;
    (
      docker as unknown as {
        modem: {
          demuxStream: ReturnType<typeof vi.fn>;
          followProgress: ReturnType<typeof vi.fn>;
        };
      }
    ).modem.demuxStream = vi.fn(
      (_attached: unknown, stdoutPipe: PassThrough) => {
        capturedStdout = stdoutPipe;
      },
    );

    container.wait = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<{ StatusCode: number }>((r) =>
            setTimeout(() => r({ StatusCode: 0 }), 500),
          ),
      );
    container.start = vi.fn().mockResolvedValue(undefined);

    const sandbox = createDockerSandbox(() => docker);
    const streamIter = sandbox.stream(makeReq({ timeoutMs: 1000 }));

    // Start iterating (first next() call starts the generator)
    const firstNextPromise = streamIter[Symbol.asyncIterator]().next();

    // Give the stream function time to set up and call start
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Flood the stdout pipe to overflow the queue
    const capturedOut = capturedStdout as PassThrough | null;
    if (capturedOut !== null) {
      for (let i = 0; i < 1001; i++) {
        capturedOut.write(Buffer.from(`chunk-${i}\n`));
      }
    }

    // Drain and collect
    const firstChunk = await firstNextPromise;
    expect(firstChunk.done).toBe(false);
    expect(container.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
  });

  it("kills container when stream timeout fires", async () => {
    const { docker, container } = makeMockDockerSetup();
    const attachEmitter = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    attachEmitter.write = vi.fn();
    attachEmitter.end = vi.fn();

    container.attach = vi.fn().mockResolvedValue(attachEmitter);
    (
      docker as unknown as {
        modem: {
          demuxStream: ReturnType<typeof vi.fn>;
          followProgress: ReturnType<typeof vi.fn>;
        };
      }
    ).modem.demuxStream = vi.fn();
    container.start = vi.fn().mockResolvedValue(undefined);
    // wait() resolves AFTER the timeout (150ms > timeoutMs 50ms) so the timer fires.
    container.wait = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<{ StatusCode: number }>((r) =>
            setTimeout(() => r({ StatusCode: 0 }), 150),
          ),
      );

    const sandbox = createDockerSandbox(() => docker);
    const chunks: Array<unknown> = [];
    for await (const chunk of sandbox.stream(makeReq({ timeoutMs: 50 }))) {
      chunks.push(chunk);
    }

    // kill is called by the timeout handler (fires at ~50ms, before wait() at 150ms)
    expect(container.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
  }, 10_000);
});

// ---------------------------------------------------------------------------
// createDockerSandbox — warmup()
// ---------------------------------------------------------------------------

describe("createDockerSandbox — warmup()", () => {
  it("resolves without error when images are already cached", async () => {
    const { docker } = makeMockDockerSetup();

    const sandbox = createDockerSandbox(() => docker);
    await expect(sandbox.warmup?.()).resolves.toBeUndefined();

    // listImages called once per language (node, python, shell)
    expect(
      (docker as unknown as { listImages: ReturnType<typeof vi.fn> })
        .listImages,
    ).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Template resources — vcpu / diskMb mapping
// ---------------------------------------------------------------------------

describe("hostConfigFor — template resources", () => {
  it("maps vcpu to NanoCpus (1 vCPU = 1e9)", () => {
    const cfg = hostConfigFor(makeReq({ vcpu: 2 }), TEST_SPEC);
    expect(cfg.NanoCpus).toBe(2 * 1_000_000_000);
  });

  it("clamps vcpu to the ceiling of 4", () => {
    const cfg = hostConfigFor(makeReq({ vcpu: 99 }), TEST_SPEC);
    expect(cfg.NanoCpus).toBe(4 * 1_000_000_000);
  });

  it("defaults to the 0.5-CPU floor when vcpu is unset", () => {
    const cfg = hostConfigFor(makeReq(), TEST_SPEC);
    expect(cfg.NanoCpus).toBe(500_000_000);
  });

  it("maps diskMb to the /work tmpfs size, leaving /tmp at the image default", () => {
    const cfg = hostConfigFor(makeReq({ diskMb: 1024 }), TEST_SPEC);
    const mounts = cfg.Tmpfs as Record<string, string>;
    expect(mounts["/work"]).toContain(`${1024 * 1024 * 1024}`);
    expect(mounts["/tmp"]).toContain(`${TEST_SPEC.tmpfsBytes}`);
  });
});

// ---------------------------------------------------------------------------
// Custom image (imageRef) — template runtime override
// ---------------------------------------------------------------------------

describe("createDockerSandbox — custom image (imageRef)", () => {
  it("uses req.imageRef as the container image and image check, overriding the language default", async () => {
    const { docker, container, attachEmitter } = makeMockDockerSetup();
    container.start = vi.fn().mockImplementation(async () => {
      setImmediate(() => attachEmitter.emit("end"));
    });

    const ref = "ghcr.io/acme/prewarmed@sha256:deadbeef";
    const sandbox = createDockerSandbox(() => docker);
    await sandbox.run(makeReq({ imageRef: ref }));

    const createCall = (
      docker as unknown as { createContainer: ReturnType<typeof vi.fn> }
    ).createContainer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createCall.Image).toBe(ref);
    expect(
      (docker as unknown as { listImages: ReturnType<typeof vi.fn> })
        .listImages,
    ).toHaveBeenCalledWith({ filters: { reference: [ref] } });
  });
});
