/**
 * `tacho enroll` (spec section 5.1): the one command that puts a machine
 * under Oxagen control. Each step is idempotent and printed as it runs.
 */
import { existsSync } from "node:fs";
import { verifyBundle } from "../host/bundle";
import { ControlError } from "../host/control-client";
import { loadOrCreateDeviceKey } from "../host/device-key";
import { ensureDir } from "../host/fs";
import {
  HOST_FILE_SCHEMA,
  type HostFile,
  readHostFile,
  writeHostFile,
} from "../host/host-file";
import {
  type HookInstallConfig,
  mergeTachoSettings,
  renderManagedSettings,
} from "../host/settings-writer";
import { toProtocolTimestamp } from "../timestamp";
import { enrollmentResponseSchema } from "../wire";
import {
  type CliDeps,
  type CredentialOptions,
  resolveCredentials,
} from "./deps";

export interface EnrollOptions extends CredentialOptions {
  managed?: boolean;
  printManaged?: boolean;
  port?: number;
  /** Install the user service (default true). */
  service?: boolean;
  validityDays?: number;
  /** Re-enroll even when a live enrollment exists. */
  force?: boolean;
}

export interface EnrollResult {
  ok: boolean;
  host?: HostFile;
  managedSettings?: unknown;
  warnings: string[];
}

const TESTED_CLAUDE_RANGE = { min: "2.1.0", max: "2.99.99" };

function versionWithin(
  version: string,
  range: { min: string; max: string },
): boolean {
  const parts = (v: string) => v.split(".").map((n) => Number(n));
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i += 1) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const v = parts(version);
  return cmp(v, parts(range.min)) >= 0 && cmp(v, parts(range.max)) <= 0;
}

async function callEnrollment(
  deps: CliDeps,
  credentials: {
    token: string;
    org: string;
    workspace: string;
    apiUrl: string;
  },
  body: Record<string, unknown>,
): Promise<ReturnType<typeof enrollmentResponseSchema.parse>> {
  const url = `${credentials.apiUrl}/v1/${credentials.org}/${credentials.workspace}/tacho/enrollments`;
  let response: Awaited<ReturnType<CliDeps["fetch"]>>;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
        "User-Agent": `tacho/${deps.wrapperVersion}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `cannot reach ${credentials.apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  if (!response.ok) throw new ControlError(response.status, text);
  return enrollmentResponseSchema.parse(JSON.parse(text));
}

export async function enroll(
  options: EnrollOptions,
  deps: CliDeps,
): Promise<EnrollResult> {
  const warnings: string[] = [];
  const step = (n: number, text: string) => deps.out(`[${n}/6] ${text}`);

  const existing = readHostFile(deps.paths.hostFile);
  let host: HostFile;
  if (
    existing !== undefined &&
    existing.revoked_at === null &&
    options.force !== true
  ) {
    deps.out(
      `Already enrolled as ${existing.agent_key} (${existing.host_enrollment_id}); re-applying settings and service. Pass --force to enroll again.`,
    );
    host = existing;
  } else {
    step(1, "Authenticating with Oxagen");
    const resolved = resolveCredentials(options, deps.env, deps.home);
    if ("missing" in resolved) {
      deps.err(
        `Not logged in. Provide ${resolved.missing.join(", ")} or run \`oxagen login\` first.`,
      );
      return { ok: false, warnings };
    }
    const { credentials } = resolved;

    step(2, `Generating the host device key at ${deps.paths.deviceKey}`);
    ensureDir(deps.paths.root);
    const { key, created } = loadOrCreateDeviceKey(deps.paths.deviceKey);
    deps.out(
      `      ${created ? "created" : "reusing"} ed25519 key ${key.fingerprint}`,
    );

    const claude = deps.claude();
    step(
      3,
      `Enrolling ${deps.hostname} in ${credentials.org}/${credentials.workspace}`,
    );
    let response: Awaited<ReturnType<typeof callEnrollment>>;
    try {
      response = await callEnrollment(deps, credentials, {
        hostname: deps.hostname,
        osUser: deps.osUser,
        platform: deps.platform,
        osVersion: deps.osVersion,
        arch: deps.arch,
        devicePublicKey: key.publicKey,
        harnesses: ["claude-code"],
        ...(claude.version !== undefined
          ? { claudeVersion: claude.version }
          : {}),
        ...(claude.path !== undefined ? { claudeExecpath: claude.path } : {}),
        nodeVersion: deps.nodeVersion,
        wrapperVersion: deps.wrapperVersion,
        ...(deps.env["SHELL"] !== undefined
          ? { shell: deps.env["SHELL"] }
          : {}),
        managed: options.managed === true || options.printManaged === true,
        validityDays: options.validityDays ?? 180,
      });
    } catch (error) {
      if (
        error instanceof ControlError &&
        (error.status === 401 || error.status === 403)
      ) {
        deps.err(
          `Oxagen refused the enrollment (${error.status}): your token cannot create Tacho enrollments in ${credentials.org}/${credentials.workspace}. An org Owner or Admin can, or can grant create_tacho_enrollment to your role.`,
        );
      } else {
        deps.err(
          `Enrollment failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { ok: false, warnings };
    }
    const verification = verifyBundle(
      response.policyBundle,
      response.bundlePublicKeyPem,
    );
    if (!verification.ok) {
      deps.err(
        `The initial policy bundle does not verify against the delivered key (${verification.reason ?? "unknown"}); refusing to enroll.`,
      );
      return { ok: false, warnings };
    }
    const port = options.port ?? existing?.port ?? (await deps.findFreePort());
    const now = toProtocolTimestamp(deps.now());
    host = {
      schema: HOST_FILE_SCHEMA,
      host_enrollment_id: response.hostEnrollmentId,
      agent_key: response.agentKey,
      organization_id: response.enrollment.claims.organization_id,
      workspace_id: response.enrollment.claims.workspace_id,
      org_slug: credentials.org,
      workspace_slug: credentials.workspace,
      api_url: credentials.apiUrl,
      api_key: response.apiKey,
      api_key_public_id: response.apiKeyPublicId,
      endpoints: {
        ingest: response.enrollment.claims.ingest_endpoint,
        bundle: response.enrollment.claims.bundle_endpoint,
        commands: response.enrollment.claims.commands_endpoint,
      },
      enrollment: {
        claims: response.enrollment.claims,
        signature_hex: response.enrollment.signature_hex,
      },
      bundle: response.policyBundle,
      bundle_public_key_pem: response.bundlePublicKeyPem,
      bundle_fetched_at: now,
      deny_generation: response.policyBundle.deny_generation,
      host_status: response.policyBundle.host_status,
      device_key_fingerprint: key.fingerprint,
      device_public_key: key.publicKey,
      port,
      local_token: existing?.local_token ?? deps.randomToken(),
      hostname: deps.hostname,
      os_user: deps.osUser,
      platform: deps.platform as HostFile["platform"],
      harnesses: ["claude-code"],
      managed: options.managed === true || options.printManaged === true,
      claude_version: claude.version ?? null,
      claude_execpath: claude.path ?? null,
      wrapper_version: deps.wrapperVersion,
      hook_command: deps.runtime.hookCommand,
      daemon_command: deps.runtime.daemonCommand,
      displaced_env: {},
      enrolled_at: now,
      expires_at: response.expiresAt,
      revoked_at: null,
    };
    writeHostFile(deps.paths.hostFile, host);
    deps.out(
      `      enrolled as ${host.agent_key} (${host.host_enrollment_id}); bundle v${host.bundle.version}, mode ${host.bundle.mode}`,
    );
  }

  const hookConfig: HookInstallConfig = {
    enrollmentId: host.host_enrollment_id,
    hookCommand: host.hook_command,
    port: host.port,
    localToken: host.local_token,
    ...(deps.env["TACHO_HOME"] !== undefined
      ? { tachoHome: deps.env["TACHO_HOME"] }
      : {}),
  };

  step(
    4,
    options.service === false
      ? "Skipping the user service (--no-service)"
      : `Installing tachod as a user service (${deps.serviceManager.kind})`,
  );
  if (options.service !== false) {
    try {
      deps.serviceManager.install({
        command: host.daemon_command,
        env: {
          ...(deps.env["TACHO_HOME"] !== undefined
            ? { TACHO_HOME: deps.env["TACHO_HOME"] }
            : {}),
          ...(deps.env["CLAUDE_CONFIG_DIR"] !== undefined
            ? { CLAUDE_CONFIG_DIR: deps.env["CLAUDE_CONFIG_DIR"] }
            : {}),
          PATH: deps.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: deps.home,
        },
        logPath: deps.paths.log,
        workingDirectory: deps.paths.root,
      });
      deps.out(`      ${deps.serviceManager.unitPath}`);
    } catch (error) {
      warnings.push(
        `service install failed: ${error instanceof Error ? error.message : String(error)}; run \`tacho daemon\` yourself`,
      );
      deps.err(`      ${warnings[warnings.length - 1] ?? ""}`);
    }
  }

  let managedSettings: unknown;
  if (options.printManaged === true) {
    step(
      5,
      "Rendering managed settings for MDM distribution (not writing user settings)",
    );
    managedSettings = renderManagedSettings(hookConfig);
    deps.out(JSON.stringify(managedSettings, null, 2));
  } else {
    step(5, `Writing Claude Code hooks into ${deps.paths.claudeSettings}`);
    const current = deps.readSettings();
    const merged = mergeTachoSettings(current, hookConfig);
    if (merged.changed) {
      deps.writeSettings(merged.settings);
      if (Object.keys(merged.displaced).length > 0) {
        host = {
          ...host,
          displaced_env: { ...host.displaced_env, ...merged.displaced },
        };
        writeHostFile(deps.paths.hostFile, host);
        warnings.push(
          `replaced existing env values (${Object.keys(merged.displaced).join(", ")}); unenroll restores them`,
        );
      }
      deps.out(
        `      hooks written for ${Object.keys(merged.settings.hooks ?? {}).length} events; env block set`,
      );
    } else {
      deps.out("      already present; nothing to change");
    }
    if (options.managed === true) {
      managedSettings = renderManagedSettings(hookConfig);
      deps.out(
        "      managed mode requested: write the following to Claude Code's managed settings path as an administrator",
      );
      deps.out(JSON.stringify(managedSettings, null, 2));
    }
  }

  step(6, "Verifying");
  const claude = deps.claude();
  if (claude.path === undefined) {
    warnings.push(
      "`claude` is not on PATH; hooks will apply once it is installed",
    );
  } else if (
    claude.version !== undefined &&
    !versionWithin(claude.version, TESTED_CLAUDE_RANGE)
  ) {
    warnings.push(
      `Claude Code ${claude.version} is outside the tested range ${TESTED_CLAUDE_RANGE.min}..${TESTED_CLAUDE_RANGE.max}`,
    );
  } else {
    deps.out(`      claude ${claude.version ?? "?"} at ${claude.path}`);
  }
  if (options.service !== false) {
    let healthy = false;
    for (let attempt = 0; attempt < 20 && !healthy; attempt += 1) {
      const health = (await deps.daemonGet("/health")) as
        | { ok?: boolean }
        | undefined;
      healthy = health?.ok === true;
      if (!healthy) await deps.sleep(250);
    }
    if (healthy)
      deps.out(
        `      tachod healthy on 127.0.0.1:${host.port} and ${deps.paths.socket}`,
      );
    else
      warnings.push(
        `tachod did not answer on 127.0.0.1:${host.port}; check ${deps.paths.log}`,
      );
  }
  if (!existsSync(deps.paths.deviceKey))
    warnings.push("device key missing after enrollment");
  for (const warning of warnings) deps.err(`warning: ${warning}`);
  deps.out(
    `Done. This machine reports to Oxagen as ${host.agent_key}; every Claude Code session from now on is recorded${host.bundle.mode === "enforce" ? " and gated" : " (observe mode)"}.`,
  );
  return {
    ok: true,
    host,
    ...(managedSettings !== undefined ? { managedSettings } : {}),
    warnings,
  };
}
