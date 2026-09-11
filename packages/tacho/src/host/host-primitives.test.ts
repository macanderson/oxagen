import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ControlError,
  ControlUnreachable,
  createControlClient,
  type FetchLike,
} from "./control-client";
import {
  deviceKeyFromPem,
  deviceKeyPem,
  generateDeviceKey,
  loadOrCreateDeviceKey,
  verifyDeviceSignature,
} from "./device-key";
import { readJsonFileIfExists, writeSensitiveFileAtomic } from "./fs";
import { applyControlFacts, readHostFile, writeHostFile } from "./host-file";
import { oxagenConfigPath, tachoPaths } from "./paths";
import {
  isProcessAlive,
  listClaudeProcesses,
  parsePsListing,
} from "./process-scan";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "./test-support";

describe("paths", () => {
  it("derives every path from TACHO_HOME and CLAUDE_CONFIG_DIR", () => {
    const paths = tachoPaths(
      { TACHO_HOME: "/t", CLAUDE_CONFIG_DIR: "/c" },
      "/home/x",
    );
    expect(paths.hostFile).toBe("/t/host.json");
    expect(paths.socket).toBe("/t/tachod.sock");
    expect(paths.claudeSettings).toBe("/c/settings.json");
    expect(paths.claudeProjects).toBe("/c/projects");
    const defaults = tachoPaths({}, "/home/x");
    expect(defaults.root).toBe("/home/x/.config/oxagen/tacho");
    expect(defaults.claudeSettings).toBe("/home/x/.claude/settings.json");
    expect(oxagenConfigPath("/home/x")).toBe(
      "/home/x/.config/oxagen/config.json",
    );
  });
});

describe("fs", () => {
  it("writes sensitive files atomically with mode 0600 and reads JSON back", () => {
    const paths = scratchPaths();
    const file = join(paths.root, "nested", "secret.json");
    writeSensitiveFileAtomic(file, JSON.stringify({ a: 1 }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readJsonFileIfExists(file)).toEqual({ a: 1 });
    expect(
      readJsonFileIfExists(join(paths.root, "missing.json")),
    ).toBeUndefined();
    writeSensitiveFileAtomic(file, "not json");
    expect(() => readJsonFileIfExists(file)).toThrow();
  });
});

describe("device key", () => {
  it("generates, persists, reloads, signs, and verifies", () => {
    const paths = scratchPaths();
    const first = loadOrCreateDeviceKey(paths.deviceKey);
    expect(first.created).toBe(true);
    expect(first.key.publicKey).toMatch(/^ed25519:[A-Za-z0-9+/=]{40,}$/);
    expect(statSync(paths.deviceKey).mode & 0o777).toBe(0o600);
    const second = loadOrCreateDeviceKey(paths.deviceKey);
    expect(second.created).toBe(false);
    expect(second.key.fingerprint).toBe(first.key.fingerprint);
    const signature = second.key.sign("chain-head");
    expect(
      verifyDeviceSignature(first.key.publicKey, "chain-head", signature),
    ).toBe(true);
    expect(verifyDeviceSignature(first.key.publicKey, "other", signature)).toBe(
      false,
    );
    expect(
      verifyDeviceSignature(
        generateDeviceKey().publicKey,
        "chain-head",
        signature,
      ),
    ).toBe(false);
    expect(verifyDeviceSignature("rsa:abc", "chain-head", signature)).toBe(
      false,
    );
    expect(verifyDeviceSignature("ed25519:AAAA", "chain-head", signature)).toBe(
      false,
    );
    expect(deviceKeyFromPem(deviceKeyPem(first.key)).fingerprint).toBe(
      first.key.fingerprint,
    );
    expect(() =>
      deviceKeyFromPem(
        "-----BEGIN PRIVATE KEY-----\nMA==\n-----END PRIVATE KEY-----",
      ),
    ).toThrow();
    writeSensitiveFileAtomic(join(paths.root, "rsa.key"), "garbage");
    expect(() => loadOrCreateDeviceKey(join(paths.root, "rsa.key"))).toThrow();
  });
});

describe("process scan", () => {
  it("finds claude processes in a ps listing and reads resume arguments", () => {
    const listing = [
      "  123     1 /usr/bin/zsh",
      "  456   123 claude --resume 340ed354 -p hi",
      "  789   123 /home/dev/.local/share/claude/versions/2.1.263 --dangerously-skip-permissions",
      "  790   123 node /opt/claude-code/cli.js",
      "  791   123 /usr/local/bin/claude",
      "garbage line",
    ].join("\n");
    const found = parsePsListing(listing);
    expect(found.map((p) => p.pid)).toEqual([456, 789, 791]);
    expect(found[0]).toMatchObject({ ppid: 123, resumeArg: "340ed354" });
    expect(found[1]?.resumeArg).toBeUndefined();
    expect(
      listClaudeProcesses(() => ({ status: 0, stdout: listing, stderr: "" })),
    ).toHaveLength(3);
    expect(
      listClaudeProcesses(() => ({ status: 1, stdout: "", stderr: "no ps" })),
    ).toEqual([]);
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 - 7)).toBe(false);
  });
});

describe("host file", () => {
  it("round-trips, validates, and applies control facts only when they move", () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    const host = testHostFile(signer, bundle);
    expect(readHostFile(paths.hostFile)).toBeUndefined();
    writeHostFile(paths.hostFile, host);
    expect(statSync(paths.hostFile).mode & 0o777).toBe(0o600);
    expect(readHostFile(paths.hostFile)).toEqual(host);
    const same = applyControlFacts(paths.hostFile, host, {
      host_status: "active",
      deny_generation: { org: 0, workspace: 1 },
    });
    expect(same).toBe(host);
    const moved = applyControlFacts(paths.hostFile, host, {
      host_status: "paused",
      deny_generation: { org: 3, workspace: 0 },
    });
    expect(moved.host_status).toBe("paused");
    expect(moved.deny_generation).toEqual({ org: 3, workspace: 1 });
    expect(readHostFile(paths.hostFile)?.host_status).toBe("paused");
    const next = signer.sign(
      unsignedBundle({ version: 4, etag: "etag-4", host_status: "active" }),
    );
    const rebundled = applyControlFacts(paths.hostFile, moved, {
      bundle: next,
      bundle_fetched_at: "2026-09-11T00:00:00.000Z",
    });
    expect(rebundled.bundle.version).toBe(4);
    expect(rebundled.host_status).toBe("active");
    expect(rebundled.bundle_fetched_at).toBe("2026-09-11T00:00:00.000Z");
    expect(
      applyControlFacts(paths.hostFile, rebundled, { bundle: next }).bundle
        .etag,
    ).toBe("etag-4");
    writeSensitiveFileAtomic(
      paths.hostFile,
      JSON.stringify({ schema: "tacho.host.v1" }),
    );
    expect(() => readHostFile(paths.hostFile)).toThrow();
    expect(existsSync(paths.hostFile)).toBe(true);
    expect(readFileSync(paths.hostFile, "utf8")).toContain("tacho.host.v1");
  });
});

describe("control client", () => {
  const endpoints = {
    ingest: "https://api.test/v1/tacho/events",
    bundle: "https://api.test/v1/tacho/bundle",
    commands: "https://api.test/v1/tacho/commands",
  };

  function client(fetch: FetchLike) {
    return createControlClient({
      endpoints,
      apiKey: "k",
      hostEnrollmentId: "tch_0123456789abcdefghjkmn",
      fetch,
      timeoutMs: 50,
    });
  }

  it("posts each call with the host key and validates the answer", async () => {
    const seen: Array<{
      url: string;
      body: unknown;
      auth: string | undefined;
    }> = [];
    const c = client(async (url, init) => {
      seen.push({
        url,
        body: JSON.parse(init.body ?? "{}"),
        auth: init.headers["Authorization"],
      });
      if (url.endsWith("/bundle"))
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ not_modified: true, etag: "e", bundle: null }),
        };
      if (url.endsWith("/commands")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              acknowledged: 1,
              control: {
                host_status: "active",
                deny_generation: { org: 1, workspace: 1 },
                bundle_etag: "e",
                commands: [],
              },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    });
    expect((await c.bundle("e")).not_modified).toBe(true);
    expect(
      (
        await c.commands([{ command_id: "c", outcome: "applied" }], {
          version: "1",
        })
      ).acknowledged,
    ).toBe(1);
    expect(seen[0]).toMatchObject({
      auth: "Bearer k",
      body: { host_enrollment_id: "tch_0123456789abcdefghjkmn", etag: "e" },
    });
    expect(seen[1]?.body).toMatchObject({
      acknowledgements: [{ command_id: "c", outcome: "applied" }],
      daemon: { version: "1" },
    });
    await expect(c.ingest([])).rejects.toThrow(); // "{}" is not an ingest response
  });

  it("distinguishes refusals from unreachable and non-JSON answers", async () => {
    await expect(
      client(async () => ({
        ok: false,
        status: 403,
        text: async () => "denied",
      })).bundle(),
    ).rejects.toBeInstanceOf(ControlError);
    await expect(
      client(async () => {
        throw new Error("ECONNREFUSED");
      }).bundle(),
    ).rejects.toBeInstanceOf(ControlUnreachable);
    await expect(
      client(async () => ({
        ok: true,
        status: 200,
        text: async () => "<html>",
      })).bundle(),
    ).rejects.toThrow(/non-JSON/);
    const slow = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    await expect(slow.bundle()).rejects.toBeInstanceOf(ControlUnreachable);
    const error = new ControlError(500, "boom");
    expect(error.message).toContain("500");
  });
});
