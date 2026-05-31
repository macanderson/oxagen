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
import { describe, it, expect } from "vitest";
import { hostConfigFor } from "./docker.js";
import type { SandboxRequest } from "./types.js";
import type { ImageSpec } from "./images.js";

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
    expect(hostConfigFor(makeReq({ network: "deny" }), TEST_SPEC).ReadonlyRootfs).toBe(true);
    expect(hostConfigFor(makeReq({ network: "allow" }), TEST_SPEC).ReadonlyRootfs).toBe(true);
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
});
