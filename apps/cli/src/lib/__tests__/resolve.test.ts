/**
 * `lib/resolve.ts` — human-handle → public-id resolution for the `env` and
 * `secret` commands. A value already shaped like a public id passes straight
 * through without a round trip; anything else is matched against the list
 * endpoint, and a miss exits non-zero with a clear message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../api.js", () => ({ apiPost: vi.fn() }));

import { apiPost } from "../api.js";
import { resolveEnvironmentId, resolveSecretKeyId } from "../resolve.js";

const mockPost = apiPost as unknown as Mock;

let err = "";
let stderr: typeof process.stderr.write;
let exit: typeof process.exit;

beforeEach(() => {
  mockPost.mockReset();
  err = "";
  stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  exit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.stderr.write = stderr;
  process.exit = exit;
});

describe("resolveEnvironmentId", () => {
  it("passes an env_ public id through without an API call", async () => {
    await expect(resolveEnvironmentId("env_abc")).resolves.toBe("env_abc");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("resolves a slug against the environment list", async () => {
    mockPost.mockResolvedValue({
      environments: [
        { id: "env_1", slug: "staging" },
        { id: "env_2", slug: "prod" },
      ],
    });
    await expect(resolveEnvironmentId("prod")).resolves.toBe("env_2");
    expect(mockPost).toHaveBeenCalledWith("environment/list", {});
  });

  it("matches case-insensitively", async () => {
    mockPost.mockResolvedValue({
      environments: [{ id: "env_1", slug: "staging" }],
    });
    await expect(resolveEnvironmentId("STAGING")).resolves.toBe("env_1");
  });

  it("exits 1 with a clear message when the slug is unknown", async () => {
    mockPost.mockResolvedValue({ environments: [] });
    await expect(resolveEnvironmentId("ghost")).rejects.toThrow("exit:1");
    expect(err).toContain("No environment with slug 'ghost'");
  });
});

describe("resolveSecretKeyId", () => {
  it("passes an sk_ public id through without an API call", async () => {
    await expect(resolveSecretKeyId("sk_abc")).resolves.toBe("sk_abc");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("resolves a key name against the secret key list", async () => {
    mockPost.mockResolvedValue({
      keys: [
        { id: "sk_1", key: "DATABASE_URL" },
        { id: "sk_2", key: "STRIPE_KEY" },
      ],
    });
    await expect(resolveSecretKeyId("STRIPE_KEY")).resolves.toBe("sk_2");
    expect(mockPost).toHaveBeenCalledWith("secret/key/list", {});
  });

  it("exits 1 with a clear message when the key is unknown", async () => {
    mockPost.mockResolvedValue({ keys: [] });
    await expect(resolveSecretKeyId("NOPE")).rejects.toThrow("exit:1");
    expect(err).toContain("No secret key named 'NOPE'");
  });
});
