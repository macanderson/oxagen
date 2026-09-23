/** Builders shared by the host and collector tests. Not part of the public surface. */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcs, type JsonValue } from "../digest";
import type {
  CodexAppServer,
  CodexRpcAnswer,
  CodexRpcRequest,
} from "./codex-app-server";
import type { PolicyBundle } from "../wire";
import { generateDeviceKey } from "./device-key";
import { HOST_FILE_SCHEMA, type HostFile } from "./host-file";
import { keyIdForPublicKey } from "./key-id";
import { tachoPaths, type TachoPaths } from "./paths";

export const TEST_ENROLLMENT = "tch_0123456789abcdefghjkmn";

export interface BundleSigner {
  publicKeyPem: string;
  sign: (bundle: Omit<PolicyBundle, "signature">) => PolicyBundle;
}

export function bundleSigner(): BundleSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    publicKeyPem,
    sign: (unsigned) => ({
      ...unsigned,
      signature: {
        key_id: keyIdForPublicKey(publicKeyPem),
        alg: "ed25519",
        sig: sign(
          null,
          Buffer.from(
            jcs(JSON.parse(JSON.stringify(unsigned)) as JsonValue),
            "utf8",
          ),
          privateKey,
        ).toString("base64"),
      },
    }),
  };
}

export function unsignedBundle(
  overrides: Partial<Omit<PolicyBundle, "signature">> = {},
): Omit<PolicyBundle, "signature"> {
  return {
    schema: "tacho.bundle.v1",
    version: 3,
    etag: "etag-3",
    issued_at: "2026-09-10T00:00:00.000Z",
    expires_at: "2027-09-10T00:00:00.000Z",
    host_enrollment_id: TEST_ENROLLMENT,
    host_status: "active",
    deny_generation: { org: 1, workspace: 1 },
    permissions: {
      allow: ["Read", "Bash(git status*)", "mcp__github__*"],
      deny: ["Bash(git push*)", "Write(/etc/**)"],
      ask: ["Bash(rm *)"],
    },
    tools: {
      Bash: { risk_grade: "high", read_only: false },
      Read: { risk_grade: "low", read_only: true },
    },
    budget: { mode: "observed" },
    context: { system: "You are governed by Oxagen." },
    retention: { mode: "digest_only", classes: [] },
    mode: "enforce",
    ...overrides,
  };
}

/**
 * A path set rooted entirely in a fresh scratch directory.
 *
 * `platform` defaults to `"darwin"` rather than to `process.platform` because
 * the whole job of this helper is a path set that does not depend on the host
 * running the test. `tachoPaths` derives one field from the platform —
 * `claudeDesktopConfig`, which is undefined where Claude Desktop has no build
 * — and letting that one field read the real OS while every other field came
 * from the scratch dir made tests pass on macOS and fail on Linux CI. A test
 * that wants the no-build behaviour passes `"linux"` explicitly.
 */
export function scratchPaths(platform: NodeJS.Platform = "darwin"): TachoPaths {
  const root = mkdtempSync(join(tmpdir(), "tacho-"));
  return tachoPaths(
    {
      TACHO_HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      CURSOR_CONFIG_DIR: join(root, "cursor"),
      STELLA_HOME: join(root, "stella"),
    },
    root,
    platform,
  );
}

export function testHostFile(
  signer: BundleSigner,
  bundle: PolicyBundle,
  overrides: Partial<HostFile> = {},
): HostFile {
  const device = generateDeviceKey();
  return {
    schema: HOST_FILE_SCHEMA,
    host_enrollment_id: TEST_ENROLLMENT,
    agent_key: "acme.core.cc-laptop",
    organization_id: "org_1",
    workspace_id: "wrk_1",
    org_slug: "acme",
    workspace_slug: "core",
    api_url: "https://api.example.test",
    api_key: "oxk_test_secret",
    api_key_public_id: "key_1",
    endpoints: {
      ingest: "https://api.example.test/v1/tacho/events",
      bundle: "https://api.example.test/v1/tacho/bundle",
      commands: "https://api.example.test/v1/tacho/commands",
    },
    enrollment: {
      claims: {
        schema: "oxagen.tacho.host-enrollment.v1",
        issuer: "oxagen",
        audience: "tacho-host",
        host_enrollment_id: TEST_ENROLLMENT,
        organization_id: "org_1",
        workspace_id: "wrk_1",
        agent_key: "acme.core.cc-laptop",
        ingest_endpoint: "https://api.example.test/v1/tacho/events",
        bundle_endpoint: "https://api.example.test/v1/tacho/bundle",
        commands_endpoint: "https://api.example.test/v1/tacho/commands",
        credential_env: "OXAGEN_TACHO_HOST_KEY",
        device_key_fingerprint: device.fingerprint,
        harnesses: ["claude-code"],
        issued_at_unix_s: 1_788_000_000,
        expires_at_unix_s: 1_803_000_000,
      },
      signature_hex: "0".repeat(64),
    },
    bundle,
    bundle_public_key_pem: signer.publicKeyPem,
    bundle_fetched_at: "2026-09-10T00:00:00.000Z",
    deny_generation: bundle.deny_generation,
    host_status: bundle.host_status,
    device_key_fingerprint: device.fingerprint,
    device_public_key: device.publicKey,
    port: 47001,
    local_token: "local-token-0123456789abcdef",
    hostname: "laptop",
    os_user: "dev",
    platform: "darwin",
    harnesses: ["claude-code"],
    managed: false,
    claude_version: "2.1.263",
    claude_execpath: "/home/dev/.local/share/claude/versions/2.1.263",
    wrapper_version: "2.1.1",
    hook_command: "node /opt/tacho/tacho-hook.mjs",
    daemon_command: ["node", "/opt/tacho/tachod.mjs"],
    displaced_env: {},
    displaced_mcp_servers: {},
    gateway_api_key: "oxa_test_gateway_key",
    gateway_api_key_public_id: "akp_gateway",
    enrolled_at: "2026-09-10T00:00:00.000Z",
    expires_at: "2027-03-09T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

/**
 * A stand-in for `codex app-server` that keeps a trust table in memory and
 * answers `hooks/list` from a `hooks.json` on disk, the way Codex 0.155 does.
 *
 * It exists because the defect it guards was invisible to a stub that only
 * recorded calls: enrollment wrote the hooks file, reported success, and
 * every hook was skipped. A fake that derives each hook's key from the file
 * and reports `trusted` only once a matching hash has been written makes a
 * test fail for the same reason the real machine did.
 */
export interface FakeCodexAppServer {
  hooksPath: string;
  server: CodexAppServer;
  /** `hooks.state` as the fake's config holds it, keyed as Codex keys it. */
  trusted: Map<string, string>;
  /** Every request the fake was asked to answer, in order. */
  requests: CodexRpcRequest[];
  /** Make every later exchange fail, as an absent `codex` binary does. */
  breakWith: (problem: string | undefined) => void;
}

/** Codex's key for one hook: the file, the snake_case event, and its position. */
function fakeHookKey(
  path: string,
  event: string,
  group: number,
  index: number,
): string {
  const snake = event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
  return `${path}:${snake}:${group}:${index}`;
}

export function fakeCodexAppServer(hooksPath: string): FakeCodexAppServer {
  const trusted = new Map<string, string>();
  const requests: CodexRpcRequest[] = [];
  let broken: string | undefined;

  // Stands in for Codex's digest, whose input is undocumented. All the code
  // under test needs of it is that it changes when the hook does.
  const hashOf = (hook: unknown): string =>
    `sha256:${createHash("sha256").update(JSON.stringify(hook)).digest("hex")}`;

  const listHooks = (): unknown => {
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return { data: [{ hooks: [] }] };
    }
    const events = (document["hooks"] ?? {}) as Record<string, unknown>;
    const hooks: unknown[] = [];
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((group, groupIndex) => {
        const entries = (group as { hooks?: unknown[] }).hooks ?? [];
        entries.forEach((entry, index) => {
          const key = fakeHookKey(hooksPath, event, groupIndex, index);
          const currentHash = hashOf(entry);
          const recorded = trusted.get(key);
          hooks.push({
            key,
            currentHash,
            trustStatus:
              recorded === currentHash
                ? "trusted"
                : recorded === undefined
                  ? "untrusted"
                  : "modified",
            isManaged: false,
            enabled: true,
            eventName: event.charAt(0).toLowerCase() + event.slice(1),
            sourcePath: hooksPath,
            command: (entry as { command?: string }).command ?? "",
          });
        });
      });
    }
    return { data: [{ hooks }] };
  };

  const write = (params: unknown): CodexRpcAnswer => {
    const { keyPath, mergeStrategy, value } = (params ?? {}) as {
      keyPath?: string;
      mergeStrategy?: string;
      value?: unknown;
    };
    if (keyPath === "hooks.state" && mergeStrategy === "upsert") {
      for (const [key, record] of Object.entries(
        (value ?? {}) as Record<string, { trusted_hash?: string }>,
      ))
        if (record.trusted_hash !== undefined)
          trusted.set(key, record.trusted_hash);
      return { result: {} };
    }
    const single = /^hooks\.state\.(".*")$/.exec(keyPath ?? "");
    if (single !== null && mergeStrategy === "upsert") {
      const hash = (value as { trusted_hash?: string } | undefined)
        ?.trusted_hash;
      if (typeof hash === "string")
        trusted.set(JSON.parse(single[1] as string) as string, hash);
      return { result: {} };
    }
    if (single !== null && mergeStrategy === "replace" && value === null) {
      trusted.delete(JSON.parse(single[1] as string) as string);
      return { result: {} };
    }
    return { error: { code: -32602, message: `unexpected write ${keyPath}` } };
  };

  return {
    hooksPath,
    trusted,
    requests,
    breakWith: (problem) => {
      broken = problem;
    },
    server: async (incoming) => {
      requests.push(...incoming);
      if (broken !== undefined) return { answers: [], problem: broken };
      return {
        answers: incoming.map((request) =>
          request.method === "hooks/list"
            ? { result: listHooks() }
            : request.method === "config/value/write"
              ? write(request.params)
              : { error: { code: -32601, message: "unknown method" } },
        ),
      };
    },
  };
}
