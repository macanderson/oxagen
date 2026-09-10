/** Builders shared by the host and collector tests. Not part of the public surface. */
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcs, type JsonValue } from "../digest";
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

export function scratchPaths(): TachoPaths {
  const root = mkdtempSync(join(tmpdir(), "tacho-"));
  return tachoPaths(
    { TACHO_HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "claude") },
    root,
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
    enrolled_at: "2026-09-10T00:00:00.000Z",
    expires_at: "2027-03-09T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}
