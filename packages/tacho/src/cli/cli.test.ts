/**
 * The CLI against fakes: enrollment writes the host file, the service unit,
 * and the Claude Code hooks; unenroll reverses all of it and leaves every
 * foreign entry intact (acceptance 1, 18); status and export read what is
 * there; verify drives a fake `claude`.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../host/control-client";
import { readJsonFileIfExists, writeSensitiveFileAtomic } from "../host/fs";
import { readHostFile, writeHostFile } from "../host/host-file";
import { oxagenConfigPath, tachoPaths } from "../host/paths";
import type { ServiceManager, ServiceSpec } from "../host/service";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { Wal } from "../host/wal";
import { minimalSession } from "../test-helpers";
import type { EnrollmentResponse } from "../wire";
import { CODEX_HOOK_EVENTS, codexHookPresence } from "../host/codex-writer";
import {
  type CliDeps,
  claudeFacts,
  defaultCliDeps,
  harnessFacts,
  resolveCredentials,
  runtimeCommands,
  shellQuote,
} from "./deps";
import { detect } from "./detect";
import { enroll, parseHarnesses } from "./enroll";
import { exportCommand, resolveSessionUuid } from "./export";
import { buildTachoProgram } from "./main";
import { reassign } from "./reassign";
import { status } from "./status";
import { unenroll } from "./unenroll";
import { verify } from "./verify";

function fakeService(): ServiceManager & {
  installed?: ServiceSpec;
  uninstalled: number;
  running: boolean;
} {
  const manager = {
    kind: "launchd" as const,
    unitPath: "/fake/sh.oxagen.tachod.plist",
    installed: undefined as ServiceSpec | undefined,
    uninstalled: 0,
    running: false,
    install(spec: ServiceSpec) {
      manager.installed = spec;
      manager.running = true;
    },
    uninstall() {
      manager.uninstalled += 1;
      manager.running = false;
    },
    status() {
      return {
        installed: manager.installed !== undefined,
        running: manager.running,
      };
    },
  };
  return manager;
}

/** A second workspace's enrollment, so `reassign` is observable. */
const OTHER_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";

function enrollmentResponse(
  signer: ReturnType<typeof bundleSigner>,
  workspace = "core",
): EnrollmentResponse {
  const bundle = signer.sign(unsignedBundle({ mode: "observe" }));
  const id = workspace === "core" ? TEST_ENROLLMENT : OTHER_ENROLLMENT;
  return {
    hostEnrollmentId: id,
    agentKey: `acme.${workspace}.cc-laptop`,
    apiKeyPublicId: "key_1",
    apiKey: "oxk_host_secret",
    enrollment: {
      claims: {
        schema: "oxagen.tacho.host-enrollment.v1",
        issuer: "oxagen",
        audience: "tacho-host",
        host_enrollment_id: id,
        organization_id: "org_1",
        workspace_id: workspace === "core" ? "wrk_1" : "wrk_2",
        agent_key: `acme.${workspace}.cc-laptop`,
        ingest_endpoint: "https://api.test/v1/tacho/events",
        bundle_endpoint: "https://api.test/v1/tacho/bundle",
        commands_endpoint: "https://api.test/v1/tacho/commands",
        credential_env: "OXAGEN_TACHO_HOST_KEY",
        device_key_fingerprint: "abc",
        harnesses: ["claude-code"],
        issued_at_unix_s: 1,
        expires_at_unix_s: 2,
      },
      signature_hex: "0".repeat(64),
      verification_secret_env: "TACHO_ENROLLMENT_SIGNING_SECRET",
    },
    policyBundle: bundle,
    bundlePublicKeyPem: signer.publicKeyPem,
    expiresAt: "2027-03-09T00:00:00.000Z",
  };
}

function deps(overrides: Partial<CliDeps> = {}): CliDeps & {
  lines: string[];
  errors: string[];
  service: ReturnType<typeof fakeService>;
  requests: Array<{ url: string; body: unknown }>;
} {
  const paths = scratchPaths();
  const lines: string[] = [];
  const errors: string[] = [];
  const service = fakeService();
  const requests: Array<{ url: string; body: unknown }> = [];
  const signer = bundleSigner();
  let healthy = false;
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body ?? "{}") });
    if (url.endsWith("/tacho/enrollments")) {
      const workspace =
        /\/v1\/[^/]+\/([^/]+)\/tacho\/enrollments$/.exec(url)?.[1] ?? "core";
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(enrollmentResponse(signer, workspace)),
      };
    }
    if (url.endsWith("/tacho/enrollments/revoke")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            hostEnrollmentId: TEST_ENROLLMENT,
            status: "revoked",
            revokedAt: "x",
          }),
      };
    }
    return { ok: false, status: 404, text: async () => "no" };
  };
  const base: CliDeps = {
    paths,
    env: { PATH: "/usr/bin", SHELL: "/bin/zsh", TACHO_HOME: paths.root },
    home: join(paths.root, ".."),
    platform: "darwin",
    fetch,
    exec: (command, args) => {
      if (args[0] === "-lc")
        return { status: 0, stdout: "/usr/local/bin/claude\n", stderr: "" };
      if (args[0] === "--version")
        return { status: 0, stdout: "2.1.263 (Claude Code)\n", stderr: "" };
      if (args[0] === "-p")
        return {
          status: 0,
          stdout: JSON.stringify({ session_id: "sess-verify", result: "OK" }),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    },
    serviceManager: service,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    now: () => Date.parse("2026-09-10T12:00:00.000Z"),
    hostname: "laptop",
    osUser: "dev",
    osVersion: "25.6.0",
    arch: "arm64",
    nodeVersion: "v26.5.0",
    readSettings: () => readJsonFileIfExists(paths.claudeSettings),
    writeSettings: (document) =>
      writeSensitiveFileAtomic(
        paths.claudeSettings,
        JSON.stringify(document, null, 2),
        0o644,
      ),
    readCodexHooks: () => readJsonFileIfExists(paths.codexHooks),
    writeCodexHooks: (document) =>
      writeSensitiveFileAtomic(
        paths.codexHooks,
        JSON.stringify(document, null, 2),
        0o644,
      ),
    claude: () => ({ path: "/usr/local/bin/claude", version: "2.1.263" }),
    codex: () => ({ path: "/usr/local/bin/codex", version: "0.104.0" }),
    runtime: {
      hookCommand: "node /opt/tacho/tacho-hook.mjs",
      daemonCommand: ["node", "/opt/tacho/tachod.mjs"],
      binDir: "/opt/tacho",
    },
    daemonGet: async (path) => {
      if (!healthy && !service.running) return undefined;
      healthy = true;
      if (path === "/health") return { ok: true };
      if (path === "/status")
        return {
          uptime_s: 5,
          spool_depth: 0,
          last_ingest_at: null,
          last_error: null,
          sessions: [],
          unobserved_sessions: [],
        };
      if (path === "/sessions")
        return {
          sessions: [
            {
              session_id: "sess-verify",
              session_uuid: "11111111-1111-4111-8111-111111111111",
              sealed: true,
              seq: 6,
            },
          ],
        };
      return undefined;
    },
    findFreePort: async () => 47123,
    randomToken: () => "local-token-0123456789abcdef",
    sleep: async () => undefined,
    wrapperVersion: "2.1.1",
    ...overrides,
  };
  return { ...base, lines, errors, service, requests };
}

describe("credentials", () => {
  it("prefers flags, then env, then the CLI's config file", () => {
    const paths = scratchPaths();
    const home = join(paths.root, "home");
    writeSensitiveFileAtomic(
      oxagenConfigPath(home),
      JSON.stringify({
        token: "cfg",
        orgSlug: "acme",
        workspaceSlug: "core",
        apiUrl: "https://cfg.test/",
      }),
    );
    expect(resolveCredentials({}, {}, home)).toEqual({
      credentials: {
        token: "cfg",
        org: "acme",
        workspace: "core",
        apiUrl: "https://cfg.test",
      },
    });
    expect(
      resolveCredentials({ token: "flag" }, { OXAGEN_ORG_ID: "env-org" }, home),
    ).toEqual({
      credentials: {
        token: "flag",
        org: "env-org",
        workspace: "core",
        apiUrl: "https://cfg.test",
      },
    });
    expect(resolveCredentials({}, {}, join(paths.root, "nowhere"))).toEqual({
      missing: ["--token (or `oxagen login`)", "--org", "--workspace"],
    });
    expect(shellQuote("/plain/path")).toBe("/plain/path");
    expect(shellQuote("/with space/it's")).toBe("'/with space/it'\\''s'");
    const runtime = runtimeCommands(
      "/opt/tacho/tacho.mjs",
      { TACHO_BIN_DIR: "/custom" },
      "/usr/bin/node",
    );
    expect(runtime.hookCommand).toBe("/usr/bin/node /custom/tacho-hook.mjs");
    expect(runtime.daemonCommand).toEqual([
      "/usr/bin/node",
      "/custom/tachod.mjs",
    ]);
    const dev = runtimeCommands(
      "/repo/packages/tacho/src/cli/main.ts",
      {},
      "/usr/bin/node",
    );
    expect(dev.binDir.endsWith("/bin")).toBe(true);
    expect(claudeFacts(() => ({ status: 1, stdout: "", stderr: "" }))).toEqual(
      {},
    );
    expect(
      claudeFacts((_c, args) =>
        args[0] === "-lc"
          ? { status: 0, stdout: "/x/claude\n", stderr: "" }
          : { status: 0, stdout: "1.2.3\n", stderr: "" },
      ),
    ).toEqual({ path: "/x/claude", version: "1.2.3" });
  });
});

describe("enroll → status → unenroll", () => {
  it("enrolls a clean machine with one call and no further edits", async () => {
    const d = deps();
    const foreign = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "guard.sh" }],
          },
        ],
      },
    };
    d.writeSettings(foreign);
    const result = await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "core",
        apiUrl: "https://api.test",
      },
      d,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    const host = readHostFile(d.paths.hostFile);
    expect(host).toMatchObject({
      host_enrollment_id: TEST_ENROLLMENT,
      agent_key: "acme.core.cc-laptop",
      port: 47123,
      api_key: "oxk_host_secret",
      claude_version: "2.1.263",
    });
    expect(existsSync(d.paths.deviceKey)).toBe(true);
    expect(d.requests[0]).toMatchObject({
      url: "https://api.test/v1/acme/core/tacho/enrollments",
      body: {
        hostname: "laptop",
        platform: "darwin",
        harnesses: ["claude-code"],
        claudeVersion: "2.1.263",
        validityDays: 180,
        managed: false,
      },
    });
    expect(
      String(
        (d.requests[0]?.body as { devicePublicKey: string }).devicePublicKey,
      ),
    ).toMatch(/^ed25519:/);
    expect(d.service.installed).toMatchObject({
      command: ["node", "/opt/tacho/tachod.mjs"],
      env: { TACHO_HOME: d.paths.root, HOME: d.home },
    });
    const settings = readJsonFileIfExists(d.paths.claudeSettings) as {
      hooks: Record<string, unknown[]>;
      env: Record<string, string>;
      permissions: unknown;
    };
    expect(settings.permissions).toEqual(foreign.permissions);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.env.TACHO_ENROLLMENT).toBe(TEST_ENROLLMENT);
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "http://127.0.0.1:47123",
    );
    expect(d.lines.some((l) => l.includes("tachod healthy"))).toBe(true);
    expect(d.lines.at(-1)).toContain("observe mode");
    // Idempotent: a second run re-applies without another enrollment call.
    const again = await enroll({}, d);
    expect(again.ok).toBe(true);
    expect(
      d.requests.filter((r) => r.url.endsWith("/tacho/enrollments")),
    ).toHaveLength(1);
    expect(d.lines.some((l) => l.includes("Already enrolled"))).toBe(true);
    expect(d.lines.some((l) => l.includes("already present"))).toBe(true);

    const report = await status({}, d);
    expect(report.enrolled).toBe(true);
    expect(report.hooks?.complete).toBe(true);
    expect(report.service).toMatchObject({
      kind: "launchd",
      installed: true,
      running: true,
    });
    expect(report.daemon).toMatchObject({ uptime_s: 5 });
    await status({ json: true }, d);
    expect(JSON.parse(d.lines.at(-1) ?? "{}")).toMatchObject({
      enrolled: true,
    });

    const verified = await verify({}, d);
    expect(verified).toMatchObject({
      ok: true,
      sessionId: "sess-verify",
      seq: 6,
    });

    const removed = await unenroll({ token: "tok" }, d);
    expect(removed).toMatchObject({
      ok: true,
      settingsChanged: true,
      revoked: true,
    });
    expect(readJsonFileIfExists(d.paths.claudeSettings)).toEqual(foreign);
    expect(d.service.uninstalled).toBe(1);
    expect(existsSync(d.paths.hostFile)).toBe(false);
    expect(existsSync(d.paths.deviceKey)).toBe(false);
    expect(d.requests.at(-1)).toMatchObject({
      url: "https://api.test/v1/acme/core/tacho/enrollments/revoke",
      body: { hostEnrollmentId: TEST_ENROLLMENT },
    });
    expect((await status({}, d)).enrolled).toBe(false);
    expect(await unenroll({}, d)).toMatchObject({
      ok: true,
      settingsChanged: false,
    });
  });

  it("fails clearly without credentials, on a refusal, and on a bad bundle", async () => {
    const none = deps({ env: {}, home: join(scratchPaths().root, "empty") });
    expect((await enroll({}, none)).ok).toBe(false);
    expect(none.errors[0]).toContain("Not logged in");
    const refused = deps({
      fetch: async () => ({
        ok: false,
        status: 403,
        text: async () => "forbidden",
      }),
    });
    expect(
      (
        await enroll(
          { token: "t", org: "o", workspace: "w", apiUrl: "https://x" },
          refused,
        )
      ).ok,
    ).toBe(false);
    expect(refused.errors[0]).toContain("refused the enrollment (403)");
    const down = deps({
      fetch: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(
      (
        await enroll(
          { token: "t", org: "o", workspace: "w", apiUrl: "https://x" },
          down,
        )
      ).ok,
    ).toBe(false);
    expect(down.errors[0]).toContain("cannot reach https://x");
    const rogue = deps({
      fetch: async () => {
        const response = enrollmentResponse(bundleSigner());
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ...response,
              bundlePublicKeyPem: bundleSigner().publicKeyPem,
            }),
        };
      },
    });
    expect(
      (
        await enroll(
          { token: "t", org: "o", workspace: "w", apiUrl: "https://x" },
          rogue,
        )
      ).ok,
    ).toBe(false);
    expect(rogue.errors[0]).toContain("does not verify");
  });

  it("warns instead of failing when the service or claude are missing, and prints managed settings", async () => {
    const d = deps({
      claude: () => ({}),
      daemonGet: async () => undefined,
    });
    d.service.install = () => {
      throw new Error("launchctl missing");
    };
    const result = await enroll(
      {
        token: "t",
        org: "o",
        workspace: "w",
        apiUrl: "https://x",
        managed: true,
      },
      d,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("service install failed");
    expect(result.warnings.join("\n")).toContain("not on PATH");
    expect(result.warnings.join("\n")).toContain("did not answer");
    expect(result.managedSettings).toMatchObject({
      allowManagedHooksOnly: true,
    });
    const printed = deps();
    const managed = await enroll(
      {
        token: "t",
        org: "o",
        workspace: "w",
        apiUrl: "https://x",
        printManaged: true,
        service: false,
      },
      printed,
    );
    expect(managed.ok).toBe(true);
    expect(readJsonFileIfExists(printed.paths.claudeSettings)).toBeUndefined();
    expect(printed.service.installed).toBeUndefined();
    const old = deps({
      claude: () => ({ path: "/x/claude", version: "1.0.0" }),
    });
    const oldResult = await enroll(
      {
        token: "t",
        org: "o",
        workspace: "w",
        apiUrl: "https://x",
        service: false,
      },
      old,
    );
    expect(oldResult.warnings.join("\n")).toContain("outside the tested range");
    // Displaced env values are recorded and restored.
    const displaced = deps();
    displaced.writeSettings({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://mine:4318" },
    });
    await enroll(
      {
        token: "t",
        org: "o",
        workspace: "w",
        apiUrl: "https://x",
        service: false,
      },
      displaced,
    );
    expect(readHostFile(displaced.paths.hostFile)?.displaced_env).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://mine:4318",
    });
    await unenroll({ token: "t" }, displaced);
    expect(
      (
        readJsonFileIfExists(displaced.paths.claudeSettings) as {
          env: Record<string, string>;
        }
      ).env,
    ).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://mine:4318" });
  });

  it("keeps the host file when the revoke cannot be made, and purges on request", async () => {
    const d = deps({ env: {}, home: join(scratchPaths().root, "nohome") });
    const signer = bundleSigner();
    writeHostFile(
      d.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    new Wal(d.paths.wal);
    const first = await unenroll({}, d);
    expect(first.revoked).toBe(false);
    expect(first.warnings[0]).toContain("no operator token");
    const marked = readHostFile(d.paths.hostFile)?.revoked_at;
    expect(marked).not.toBeNull();
    expect(existsSync(d.paths.wal)).toBe(true);
    expect(d.requests).toEqual([]);
    // The local mark means "revoke not done", never "already revoked": a
    // second run without a token still cannot revoke and keeps host.json.
    const stillNoToken = await unenroll({}, d);
    expect(stillNoToken.revoked).toBe(false);
    expect(d.requests).toEqual([]);
    expect(readHostFile(d.paths.hostFile)?.revoked_at).toBe(marked);
    // With a token the pending revoke is made, and only then does host.json go.
    const second = await unenroll({ token: "t", purge: true }, d);
    expect(second.revoked).toBe(true);
    expect(d.requests.map((r) => r.url)).toEqual([
      "https://api.example.test/v1/acme/core/tacho/enrollments/revoke",
    ]);
    expect(d.lines.join("\n")).toContain("Finishing the revoke of");
    expect(existsSync(d.paths.hostFile)).toBe(false);
    expect(existsSync(d.paths.wal)).toBe(false);
    const failing = deps({
      fetch: async () => ({ ok: false, status: 500, text: async () => "boom" }),
    });
    writeHostFile(
      failing.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    const third = await unenroll({ token: "t" }, failing);
    expect(third.revoked).toBe(false);
    expect(third.warnings[0]).toContain("revoke answered 500");
    failing.service.uninstall = () => {
      throw new Error("no launchctl");
    };
    expect(
      (await unenroll({ token: "t" }, failing)).warnings.join("\n"),
    ).toContain("service removal failed");
  });
});

describe("harnesses and reassign", () => {
  it("parses --harness lists and rejects unknown names", () => {
    expect(parseHarnesses(undefined)).toEqual(["claude-code"]);
    expect(parseHarnesses("codex")).toEqual(["codex"]);
    expect(parseHarnesses(" claude-code, codex ,codex")).toEqual([
      "claude-code",
      "codex",
    ]);
    // One line naming the choices, not a ZodError's JSON issues array: both
    // CLIs print the message verbatim.
    expect(() => parseHarnesses("cursor")).toThrow(
      'unknown harness "cursor"; expected one of claude-code, codex',
    );
    expect(() => parseHarnesses("claude_code")).toThrow(
      /unknown harness "claude_code"/,
    );
  });

  it("`tacho enroll` passes no harness list unless --harness is given", () => {
    // A commander default of "claude-code" would make a bare `tacho enroll`
    // on a Codex-only host add Claude Code hooks; enroll() defaults the
    // fresh-enrollment case itself.
    const enrollCommand = buildTachoProgram()
      .commands.find((c) => c.name() === "enroll")
      ?.options.find((o) => o.long === "--harness");
    expect(enrollCommand).toBeDefined();
    expect(enrollCommand?.defaultValue).toBeUndefined();
  });

  it("enrolls Codex next to Claude Code, and unenroll strips both", async () => {
    const d = deps();
    d.writeCodexHooks({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "mine.sh" }] }],
      },
    });
    const result = await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "core",
        apiUrl: "https://api.test",
        harnesses: ["claude-code", "codex"],
      },
      d,
    );
    expect(result.ok).toBe(true);
    expect(d.requests[0]?.body).toMatchObject({
      harnesses: ["claude-code", "codex"],
    });
    const host = readHostFile(d.paths.hostFile);
    expect(host).toMatchObject({
      harnesses: ["claude-code", "codex"],
      codex_version: "0.104.0",
      codex_execpath: "/usr/local/bin/codex",
    });
    const codex = d.readCodexHooks() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    // Foreign group kept, Tacho's appended with the harness tag.
    expect(codex.hooks["PreToolUse"]?.map((g) => g.hooks[0]?.command)).toEqual([
      "mine.sh",
      `node /opt/tacho/tacho-hook.mjs --enrollment ${TEST_ENROLLMENT} --harness codex`,
    ]);
    expect(Object.keys(codex.hooks).sort()).toEqual(
      [...CODEX_HOOK_EVENTS].sort(),
    );
    expect(codex).not.toHaveProperty("env");
    expect(codexHookPresence(codex, TEST_ENROLLMENT).complete).toBe(true);

    const report = await status({ json: true }, d);
    expect(report.host?.harnesses).toEqual(["claude-code", "codex"]);
    expect(report.codexHooks?.complete).toBe(true);
    expect(d.lines.join("\n")).toContain("Codex");

    // Re-applying without --harness keeps Codex; it never drops a harness.
    d.requests.length = 0;
    const again = await enroll({ token: "tok" }, d);
    expect(again.ok).toBe(true);
    expect(readHostFile(d.paths.hostFile)?.harnesses).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(d.requests).toEqual([]);
    // Nor does naming the harnesses it already hooks re-enroll it.
    expect(
      (await enroll({ token: "tok", harnesses: ["codex", "claude-code"] }, d))
        .ok,
    ).toBe(true);
    expect(d.requests).toEqual([]);
    // A re-apply that names another pair does not move the host; it says so.
    const elsewhere = await enroll(
      { token: "tok", org: "beta", workspace: "edge" },
      d,
    );
    expect(elsewhere.ok).toBe(true);
    expect(elsewhere.warnings.join("\n")).toContain(
      "reports to acme/core, not beta/edge",
    );
    expect(readHostFile(d.paths.hostFile)?.org_slug).toBe("acme");
    expect(d.requests).toEqual([]);

    await unenroll({ token: "tok" }, d);
    const stripped = d.readCodexHooks() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(
      stripped.hooks["PreToolUse"]?.map((g) => g.hooks[0]?.command),
    ).toEqual(["mine.sh"]);
    expect(Object.keys(stripped.hooks)).toEqual(["PreToolUse"]);
    expect(d.lines.join("\n")).toContain("removed from");
  });

  it("adds a harness to an enrolled host through a revoke and a fresh enrollment, so the control plane's record follows", async () => {
    const d = deps();
    await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "core",
        apiUrl: "https://api.test",
      },
      d,
    );
    const before = readHostFile(d.paths.hostFile);
    d.requests.length = 0;
    d.lines.length = 0;
    // No --force: the addition itself is what re-enrolls. The revoke goes
    // to the host's own org and workspace whatever the caller passes as a
    // pair (the CLI's config.json default may name another org).
    const grown = await enroll(
      {
        token: "tok",
        org: "other",
        workspace: "elsewhere",
        harnesses: ["claude-code", "codex"],
      },
      d,
    );
    expect(grown.ok).toBe(true);
    expect(d.requests.map((r) => r.url)).toEqual([
      "https://api.test/v1/acme/core/tacho/enrollments/revoke",
      "https://api.test/v1/acme/core/tacho/enrollments",
    ]);
    expect(d.requests[0]?.body).toMatchObject({
      hostEnrollmentId: TEST_ENROLLMENT,
      reason: "tacho enroll --harness claude-code,codex",
    });
    expect(d.requests[1]?.body).toMatchObject({
      harnesses: ["claude-code", "codex"],
    });
    expect(d.lines.join("\n")).toContain("adding codex to");
    const after = readHostFile(d.paths.hostFile);
    expect(after).toMatchObject({
      harnesses: ["claude-code", "codex"],
      org_slug: "acme",
      workspace_slug: "core",
      port: before?.port,
      local_token: before?.local_token,
      device_key_fingerprint: before?.device_key_fingerprint,
      revoked_at: null,
      codex_version: "0.104.0",
    });
    expect(
      codexHookPresence(d.readCodexHooks(), TEST_ENROLLMENT).complete,
    ).toBe(true);
    // Without a token the addition is refused before anything is revoked.
    const offline = deps({
      env: {},
      home: join(scratchPaths().root, "nohome"),
    });
    await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "core",
        apiUrl: "https://api.test",
      },
      offline,
    );
    offline.requests.length = 0;
    const refused = await enroll(
      { harnesses: ["claude-code", "codex"] },
      offline,
    );
    expect(refused.ok).toBe(false);
    expect(offline.requests).toEqual([]);
    expect(readHostFile(offline.paths.hostFile)).toMatchObject({
      harnesses: ["claude-code"],
      revoked_at: null,
    });
  });

  it("reassigns to another workspace keeping the device key and port", async () => {
    const d = deps();
    await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "core",
        apiUrl: "https://api.test",
        harnesses: ["claude-code", "codex"],
      },
      d,
    );
    const before = readHostFile(d.paths.hostFile);
    const keyBefore = readFileSync(d.paths.deviceKey, "utf8");
    d.requests.length = 0;

    const result = await reassign({ token: "tok", workspace: "edge" }, d);
    expect(result.ok).toBe(true);
    expect(result.from).toEqual({
      org: "acme",
      workspace: "core",
      enrollmentId: TEST_ENROLLMENT,
    });
    expect(result.to).toEqual({
      org: "acme",
      workspace: "edge",
      enrollmentId: OTHER_ENROLLMENT,
    });
    // Revoke of the old, then a create in the new workspace.
    expect(d.requests.map((r) => r.url)).toEqual([
      "https://api.test/v1/acme/core/tacho/enrollments/revoke",
      "https://api.test/v1/acme/edge/tacho/enrollments",
    ]);
    expect(d.requests[0]?.body).toMatchObject({
      hostEnrollmentId: TEST_ENROLLMENT,
      reason: "tacho reassign to acme/edge",
    });
    expect(d.requests[1]?.body).toMatchObject({
      harnesses: ["claude-code", "codex"],
    });
    const after = readHostFile(d.paths.hostFile);
    expect(after).toMatchObject({
      host_enrollment_id: OTHER_ENROLLMENT,
      workspace_slug: "edge",
      workspace_id: "wrk_2",
      port: before?.port,
      local_token: before?.local_token,
      device_key_fingerprint: before?.device_key_fingerprint,
      harnesses: ["claude-code", "codex"],
      revoked_at: null,
    });
    expect(readFileSync(d.paths.deviceKey, "utf8")).toBe(keyBefore);
    // Hooks now carry only the new enrollment id, in both harnesses.
    const settings = JSON.stringify(d.readSettings());
    expect(settings).not.toContain(TEST_ENROLLMENT);
    expect(settings).toContain(OTHER_ENROLLMENT);
    const codex = JSON.stringify(d.readCodexHooks());
    expect(codex).not.toContain(TEST_ENROLLMENT);
    expect(codex).toContain(OTHER_ENROLLMENT);

    // Same target is a no-op; not enrolled, no --workspace, and --org
    // without --workspace are errors (the current slug is not a workspace
    // of the other org, or worse, a same-named one nobody chose).
    d.requests.length = 0;
    expect((await reassign({ workspace: "edge" }, d)).ok).toBe(true);
    expect(d.requests).toEqual([]);
    expect((await reassign({ token: "tok" }, d)).ok).toBe(false);
    expect((await reassign({ token: "tok", org: "other" }, d)).ok).toBe(false);
    expect(d.errors.at(-1)).toContain("--org other needs --workspace <slug>");
    expect(d.requests).toEqual([]);

    // A harness-only change re-enrolls in place: the one way to drop Codex.
    const dropped = await reassign(
      { token: "tok", harnesses: ["claude-code"] },
      d,
    );
    expect(dropped.ok).toBe(true);
    expect(dropped.to?.workspace).toBe("edge");
    expect(readHostFile(d.paths.hostFile)?.harnesses).toEqual(["claude-code"]);
    expect(JSON.stringify(d.readCodexHooks())).not.toContain("--enrollment");
    const fresh = deps();
    expect((await reassign({ workspace: "edge" }, fresh)).ok).toBe(false);
    expect(fresh.errors[0]).toContain("Not enrolled");
  });

  it("retries a pending revoke before moving, and leaves host.json retired when the new enrollment fails", async () => {
    const d = deps();
    await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "core",
        apiUrl: "https://api.test",
      },
      d,
    );
    const host = readHostFile(d.paths.hostFile);
    if (host === undefined) throw new Error("not enrolled");
    // A marked host.json is one whose revoke did not go through (offline
    // unenroll); the move asks the control plane again before enrolling.
    writeHostFile(d.paths.hostFile, {
      ...host,
      revoked_at: "2026-09-10T11:00:00.000Z",
    });
    d.requests.length = 0;
    const moved = await reassign({ token: "tok", workspace: "edge" }, d);
    expect(moved.ok).toBe(true);
    expect(d.lines.join("\n")).toContain(
      "pending since 2026-09-10T11:00:00.000Z",
    );
    expect(d.requests.map((r) => r.url)).toEqual([
      "https://api.test/v1/acme/core/tacho/enrollments/revoke",
      "https://api.test/v1/acme/edge/tacho/enrollments",
    ]);
    expect(readHostFile(d.paths.hostFile)?.revoked_at).toBeNull();

    // When the create is refused after the revoke went through, host.json
    // stays but marked retired: status says so, and the recovery command
    // enrolls afresh instead of re-applying the revoked enrollment's hooks.
    const refusing = deps();
    await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "core",
        apiUrl: "https://api.test",
      },
      refusing,
    );
    const upstream = refusing.fetch;
    refusing.fetch = async (url, init) => {
      if (url.endsWith("/tacho/enrollments"))
        return { ok: false, status: 403, text: async () => "workspace closed" };
      return upstream(url, init);
    };
    refusing.lines.length = 0;
    const failed = await reassign(
      { token: "tok", workspace: "edge" },
      refusing,
    );
    expect(failed.ok).toBe(false);
    expect(failed.from?.enrollmentId).toBe(TEST_ENROLLMENT);
    expect(failed.to).toBeUndefined();
    expect(refusing.errors.at(-1)).toContain(
      "Reassign failed after revoking the old enrollment",
    );
    expect(refusing.errors.at(-1)).toContain(
      "tacho enroll --force --org acme --workspace edge --api-url https://api.test",
    );
    const left = readHostFile(refusing.paths.hostFile);
    expect(left?.host_enrollment_id).toBe(TEST_ENROLLMENT);
    expect(left?.revoked_at).not.toBeNull();
    expect(JSON.stringify(refusing.readSettings())).not.toContain(
      TEST_ENROLLMENT,
    );
    // The printed recovery, and the same command without --force, both
    // take the fresh path: the marked enrollment is never re-applied.
    refusing.fetch = upstream;
    refusing.requests.length = 0;
    const recovered = await enroll(
      {
        token: "tok",
        org: "acme",
        workspace: "edge",
        apiUrl: "https://api.test",
      },
      refusing,
    );
    expect(recovered.ok).toBe(true);
    expect(refusing.requests.map((r) => r.url)).toEqual([
      "https://api.test/v1/acme/edge/tacho/enrollments",
    ]);
    expect(readHostFile(refusing.paths.hostFile)).toMatchObject({
      host_enrollment_id: OTHER_ENROLLMENT,
      workspace_slug: "edge",
      revoked_at: null,
    });
  });
  it("uses the multi-call binary when compiled and quotes for cmd.exe on Windows", () => {
    const native = runtimeCommands(
      undefined,
      {},
      "/Applications/Oxagen.app/Contents/MacOS/tacho",
      "darwin",
      true,
    );
    expect(native.binDir).toBe("/Applications/Oxagen.app/Contents/MacOS");
    expect(native.hookCommand).toBe(
      "/Applications/Oxagen.app/Contents/MacOS/tacho hook",
    );
    expect(native.daemonCommand).toEqual([
      "/Applications/Oxagen.app/Contents/MacOS/tacho",
      "daemon",
    ]);
    const win = runtimeCommands(
      undefined,
      {},
      "C:\\Program Files\\Oxagen\\tacho.exe",
      "win32",
      true,
    );
    expect(win.hookCommand).toBe('"C:\\Program Files\\Oxagen\\tacho.exe" hook');
    expect(win.daemonCommand).toEqual([
      "C:\\Program Files\\Oxagen\\tacho.exe",
      "daemon",
    ]);
    // A directory holding only the compiled binary (TACHO_BIN_DIR from the
    // desktop app) is the native layout even when this process is not.
    const dir = mkdtempSync(join(tmpdir(), "tacho-bin-"));
    writeFileSync(join(dir, "tacho"), "");
    const pointed = runtimeCommands(
      undefined,
      { TACHO_BIN_DIR: dir },
      "/usr/bin/node",
      "darwin",
      false,
    );
    expect(pointed.daemonCommand).toEqual([join(dir, "tacho"), "daemon"]);
    expect(shellQuote("C:\\a b\\x.exe", "win32")).toBe('"C:\\a b\\x.exe"');
    expect(
      harnessFacts(
        (command, args) =>
          command === "where"
            ? {
                status: 0,
                stdout: "C:\\npm\\codex.cmd\r\nC:\\other\\codex.cmd\r\n",
                stderr: "",
              }
            : { status: 0, stdout: `codex-cli 0.104.0\n`, stderr: "" },
        "codex",
        "win32",
      ),
    ).toEqual({ path: "C:\\npm\\codex.cmd", version: "0.104.0" });
  });
});

describe("export and verify", () => {
  it("lists and exports sessions from the WAL by id or uuid", async () => {
    const d = deps();
    const wal = new Wal(d.paths.wal);
    const events = minimalSession();
    wal.append(events);
    const uuid = events[0]?.session_uuid as string;
    const sessionId = events[0]?.session_id as string;
    expect(resolveSessionUuid(wal, uuid)).toBe(uuid);
    expect(resolveSessionUuid(wal, sessionId)).toBe(uuid);
    expect(resolveSessionUuid(wal, "nope")).toBeUndefined();
    expect(await exportCommand({ list: true }, d)).toBe(true);
    expect(d.lines.at(-1)).toContain(
      `${uuid}  ${sessionId}  ${events.length} events`,
    );
    expect(
      await exportCommand({ session: sessionId, format: "trace" }, d),
    ).toBe(true);
    expect(d.lines.at(-1)).toContain("session_start");
    const out = join(d.paths.root, "out.json");
    expect(await exportCommand({ session: uuid, format: "otlp", out }, d)).toBe(
      true,
    );
    expect(readFileSync(out, "utf8")).toContain("resourceSpans");
    expect(await exportCommand({ session: "nope" }, d)).toBe(false);
    expect(d.errors.at(-1)).toContain("no session nope");
    const empty = deps();
    await exportCommand({}, empty);
    expect(empty.lines.at(-1)).toContain("no sessions");
  });

  it("verify drives Codex through codex exec and matches the newest chain", async () => {
    const signer = bundleSigner();
    const calls: string[][] = [];
    const d = deps({
      exec: (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "exec")
          return { status: 0, stdout: "OK\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    d.service.running = true;
    writeHostFile(
      d.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    const result = await verify({ harness: "codex" }, d);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe("sess-verify");
    expect(calls).toContainEqual([
      "/usr/local/bin/codex",
      "exec",
      "--skip-git-repo-check",
      "Reply with exactly the word OK and nothing else.",
    ]);
    expect(d.lines.join("\n")).toContain("Running codex exec");
    const noCodex = deps({ codex: () => ({}) });
    noCodex.service.running = true;
    writeHostFile(
      noCodex.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    expect((await verify({ harness: "codex" }, noCodex)).detail).toContain(
      "codex",
    );
  });

  it("detect reports installed harnesses and which are enrolled", () => {
    const d = deps();
    const fresh = detect({}, d);
    expect(fresh.enrolled).toBe(false);
    expect(
      fresh.harnesses.map((h) => [h.harness, h.installed, h.enrolled]),
    ).toEqual([
      ["claude-code", true, false],
      ["codex", true, false],
    ]);
    expect(d.lines.join("\n")).toContain(
      "Claude Code  2.1.263 at /usr/local/bin/claude",
    );
    const signer = bundleSigner();
    writeHostFile(
      d.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        harnesses: ["claude-code"],
      }),
    );
    const missingCodex = deps({ codex: () => ({}) });
    writeHostFile(
      missingCodex.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        harnesses: ["claude-code"],
      }),
    );
    const report = detect({ json: true }, missingCodex);
    expect(report).toMatchObject({
      enrolled: true,
      harnesses: [
        { harness: "claude-code", installed: true, enrolled: true },
        { harness: "codex", installed: false, enrolled: false },
      ],
    });
    expect(JSON.parse(missingCodex.lines.join("\n"))).toEqual(report);
  });

  it("verify reports each failure mode", async () => {
    const notEnrolled = deps();
    expect(await verify({}, notEnrolled)).toMatchObject({
      ok: false,
      detail: "not enrolled",
    });
    const signer = bundleSigner();
    const down = deps({ daemonGet: async () => undefined });
    writeHostFile(
      down.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    expect((await verify({}, down)).detail).toContain("not answering");
    const noClaude = deps({ claude: () => ({}) });
    noClaude.service.running = true;
    writeHostFile(
      noClaude.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    expect((await verify({}, noClaude)).detail).toContain("not on PATH");
    const crashed = deps({
      exec: (_c, args) =>
        args[0] === "-p"
          ? { status: 1, stdout: "", stderr: "auth required" }
          : { status: 0, stdout: "", stderr: "" },
    });
    crashed.service.running = true;
    writeHostFile(
      crashed.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    expect((await verify({}, crashed)).detail).toContain("claude exited 1");
    let clock = 0;
    const unseen = deps({
      now: () => (clock += 8_000),
      exec: (_c, args) =>
        args[0] === "-p"
          ? { status: 0, stdout: "not json", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    unseen.service.running = true;
    const getter = unseen.daemonGet;
    unseen.daemonGet = async (path) =>
      path === "/sessions"
        ? {
            sessions: [
              {
                session_id: "tachod-1",
                session_uuid: "x",
                sealed: false,
                seq: 1,
              },
            ],
          }
        : getter(path);
    writeHostFile(
      unseen.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    expect((await verify({ timeoutMs: 10_000 }, unseen)).detail).toContain(
      "never saw the session",
    );
    let clock2 = 0;
    const unsealed = deps({ now: () => (clock2 += 8_000) });
    unsealed.service.running = true;
    const getter2 = unsealed.daemonGet;
    unsealed.daemonGet = async (path) =>
      path === "/sessions"
        ? {
            sessions: [
              {
                session_id: "sess-verify",
                session_uuid: "u",
                sealed: false,
                seq: 2,
              },
            ],
          }
        : getter2(path);
    writeHostFile(
      unsealed.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    expect((await verify({ timeoutMs: 10_000 }, unsealed)).detail).toContain(
      "SessionEnd never arrived",
    );
  });
});

describe("defaultCliDeps", () => {
  it("binds the ports to a scratch home: settings and hooks files, harness lookups, the service manager and the local port", async () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-home-"));
    const env = {
      TACHO_HOME: join(home, "tacho"),
      CODEX_HOME: join(home, "codex"),
    };
    const calls: string[] = [];
    const d = defaultCliDeps({
      env,
      home,
      platform: "linux",
      exec: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "sh")
          return { status: 0, stdout: "/opt/bin/tool\n", stderr: "" };
        return { status: 0, stdout: "tool 9.8.7\n", stderr: "" };
      },
    });
    expect(d.paths).toEqual(tachoPaths(env, home));
    expect(d.home).toBe(home);
    expect(d.platform).toBe("linux");
    expect(d.serviceManager.kind).toBe("systemd");
    expect(d.serviceManager.unitPath.startsWith(home)).toBe(true);
    // Absent files read as undefined; a write creates the parent directory
    // and the next read returns the document.
    expect(d.readSettings()).toBeUndefined();
    expect(d.readCodexHooks()).toBeUndefined();
    d.writeSettings({ hooks: {} });
    d.writeCodexHooks({ hooks: { SessionStart: [] } });
    expect(d.readSettings()).toEqual({ hooks: {} });
    expect(d.readCodexHooks()).toEqual({ hooks: { SessionStart: [] } });
    expect(existsSync(join(home, "codex", "hooks.json"))).toBe(true);
    // Both harness lookups go through the injected exec.
    expect(d.claude()).toEqual({ path: "/opt/bin/tool", version: "9.8.7" });
    expect(d.codex()).toEqual({ path: "/opt/bin/tool", version: "9.8.7" });
    expect(calls).toContain("sh -lc command -v claude");
    expect(calls).toContain("sh -lc command -v codex");
    expect(d.runtime.daemonCommand).toHaveLength(2);
    expect(typeof d.hostname).toBe("string");
    expect(typeof d.osUser).toBe("string");
    expect(d.nodeVersion).toBe(process.version);
    expect(d.wrapperVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.randomToken()).toMatch(/^[0-9a-f]{48}$/);
    expect(d.randomToken()).not.toBe(d.randomToken());
    const port = await d.findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    const started = Date.now();
    await d.sleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    // Overrides win over the defaults they replace.
    const lines: string[] = [];
    const custom = defaultCliDeps({
      env,
      home,
      out: (line) => lines.push(line),
    });
    custom.out("hello");
    expect(lines).toEqual(["hello"]);
  });

  it("GETs the daemon on loopback with the local bearer, and answers undefined when unenrolled, unreachable, or not JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-home-"));
    const env = { TACHO_HOME: join(home, "tacho") };
    const d = defaultCliDeps({ env, home, platform: "linux" });
    // Not enrolled: no host file, no request.
    expect(await d.daemonGet("/status")).toBeUndefined();
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const server = createServer((req, res) => {
      seen.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
      });
      if (req.url === "/status") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ uptime_s: 12, spool_depth: 0 }));
      } else {
        res.end("not json");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const signer = bundleSigner();
    const host = {
      ...testHostFile(signer, signer.sign(unsignedBundle())),
      port,
    };
    writeHostFile(d.paths.hostFile, host);
    try {
      expect(await d.daemonGet("/status")).toEqual({
        uptime_s: 12,
        spool_depth: 0,
      });
      expect(seen[0]).toEqual({
        url: "/status",
        authorization: `Bearer ${host.local_token}`,
      });
      expect(await d.daemonGet("/sessions")).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The port is closed now: a refused connection is "no daemon", not an error.
    expect(await d.daemonGet("/status")).toBeUndefined();
  });
});
