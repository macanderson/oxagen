/**
 * Unit tests for the Vercel Sandbox driver.
 *
 * These are purely unit tests — no live API calls to Vercel's infrastructure
 * are made. Tests cover construction, pure helper functions, and the driver
 * selection path in getSandbox(). SANDBOX_DRIVER is process.env-gated in
 * integration environments; set it in CI env to choose the appropriate driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createVercelSandbox,
  runtimeFor,
  networkPolicyFor,
  VercelSandboxUnsupportedError,
} from "./vercel";
import { getSandbox, setSandboxForTests } from "./index";

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
