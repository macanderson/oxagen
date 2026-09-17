/**
 * `tacho enroll` (spec section 5.1): the one command that puts a machine
 * under Oxagen control. Each step is idempotent and printed as it runs.
 */
import { existsSync } from "node:fs";
import { verifyBundle } from "../host/bundle";
import {
  CLAUDE_DESKTOP_RESTART_NOTE,
  claudeDesktopPresence,
  mergeClaudeDesktopConfig,
} from "../host/claude-desktop-writer";
import { codexHookPresence, mergeCodexHooks } from "../host/codex-writer";
import { ControlError } from "../host/control-client";
import { loadOrCreateDeviceKey } from "../host/device-key";
import { ensureDir } from "../host/fs";
import { mergeStellaHooks, stellaHookPresence } from "../host/stella-writer";
import {
  HOST_FILE_SCHEMA,
  type HostFile,
  mcpEndpointOverrideFrom,
  readHostFile,
  writeHostFile,
} from "../host/host-file";
import {
  type HookInstallConfig,
  mergeTachoSettings,
  renderManagedSettings,
} from "../host/settings-writer";
import { toProtocolTimestamp } from "../timestamp";
import {
  enrollmentResponseSchema,
  TACHO_HARNESS_LABELS,
  type TachoHarness,
  tachoHarnessSchema,
  type TokenEnrollmentResponse,
  tokenEnrollmentResponseSchema,
} from "../wire";
import {
  type CliDeps,
  type CredentialOptions,
  resolveApiUrl,
  resolveCredentials,
} from "./deps";
import { revokeAndMark, stripEnrollmentHooks } from "./unenroll";

export interface EnrollOptions extends CredentialOptions {
  /**
   * A one-time enrollment token from `create_enrollment_token` (`oxagen
   * agent enroll --token …`). With one, no session, org or workspace is
   * needed: the control plane resolves the tenant and the agent from the
   * token, and the host file records what it answered.
   */
  enrollmentToken?: string;
  managed?: boolean;
  printManaged?: boolean;
  port?: number;
  /** Install the user service (default true). */
  service?: boolean;
  validityDays?: number;
  /** Re-enroll even when a live enrollment exists. */
  force?: boolean;
  /** Harnesses to hook (default: `["claude-code"]`). */
  harnesses?: TachoHarness[];
}

/**
 * Parse a `--harness` flag (`claude-code`, `codex`, `stella`, or a comma
 * list). An
 * unknown name is a one-line error naming the choices, not a ZodError
 * (whose message is the JSON issues array) — both CLIs print it verbatim.
 */
export function parseHarnesses(value: string | undefined): TachoHarness[] {
  if (value === undefined || value.trim().length === 0) return ["claude-code"];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const parsed = names.map((name) => {
    const result = tachoHarnessSchema.safeParse(name);
    if (!result.success) {
      throw new Error(
        `unknown harness "${name}"; expected one of ${tachoHarnessSchema.options.join(", ")}`,
      );
    }
    return result.data;
  });
  return [...new Set(parsed)];
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

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Stella". */
function listLabels(harnesses: readonly TachoHarness[]): string {
  const labels = harnesses.map((harness) => TACHO_HARNESS_LABELS[harness]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}`;
}

async function postEnrollment(
  deps: CliDeps,
  apiUrl: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<string> {
  let response: Awaited<ReturnType<CliDeps["fetch"]>>;
  try {
    response = await deps.fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "User-Agent": `tacho/${deps.wrapperVersion}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `cannot reach ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  if (!response.ok) throw new ControlError(response.status, text);
  return text;
}

/** The operator's path: the CLI's own session against the org and workspace it picked. */
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
  const text = await postEnrollment(
    deps,
    credentials.apiUrl,
    `/v1/${credentials.org}/${credentials.workspace}/tacho/enrollments`,
    { Authorization: `Bearer ${credentials.token}` },
    body,
  );
  return enrollmentResponseSchema.parse(JSON.parse(text));
}

/** The token path: no credential but the one-time token in the body (`enroll_host`). */
async function callTokenEnrollment(
  deps: CliDeps,
  apiUrl: string,
  body: Record<string, unknown>,
): Promise<TokenEnrollmentResponse> {
  const text = await postEnrollment(deps, apiUrl, "/v1/tacho/enroll", {}, body);
  return tokenEnrollmentResponseSchema.parse(JSON.parse(text));
}

/** The git remote of the working directory, for the gate's "Repository detected" offer; undefined outside a repository. */
function repositoryRemote(deps: CliDeps): string | undefined {
  const result = deps.exec("git", ["config", "--get", "remote.origin.url"]);
  const remote = result.status === 0 ? result.stdout.trim() : "";
  return remote.length > 0 ? remote : undefined;
}

/**
 * The server's own reason from an error body, as ` — <reason>`, or "" when
 * the body carries none. The API answers `{ error: { code, message } }`.
 */
function controlErrorReason(body: string): string {
  let reason = body.trim();
  try {
    const parsed: unknown = JSON.parse(reason);
    const message = (parsed as { error?: { message?: unknown } } | null)?.error
      ?.message;
    if (typeof message === "string") reason = message;
  } catch {
    // Not JSON (plain text or a proxy's page): the text itself is the reason.
  }
  return reason === "" ? "" : ` — ${reason.slice(0, 200)}`;
}

export async function enroll(
  options: EnrollOptions,
  deps: CliDeps,
): Promise<EnrollResult> {
  const warnings: string[] = [];
  const step = (n: number, text: string) => deps.out(`[${n}/6] ${text}`);

  const existing = readHostFile(deps.paths.hostFile);
  let host: HostFile;
  let harnesses: TachoHarness[] = options.harnesses ?? ["claude-code"];
  const live =
    existing !== undefined &&
    existing.revoked_at === null &&
    options.force !== true;
  // Harnesses named on a live enrollment that it does not hook yet. Adding
  // one is a change to the control plane's host record (`tacho.hosts.
  // harnesses`), which only an enrollment writes, so it goes through a
  // revoke and a fresh enrollment — the same path `reassign --harness`
  // takes — rather than a local re-apply that the fleet page never sees.
  const added: TachoHarness[] = live
    ? (options.harnesses ?? []).filter(
        (harness) => !existing.harnesses.includes(harness),
      )
    : [];
  if (live && added.length === 0) {
    deps.out(
      `Already enrolled as ${existing.agent_key} (${existing.host_enrollment_id}); re-applying settings and service. Pass --force to enroll again.`,
    );
    // The flags (or the CLI's config.json default) may name another pair;
    // a re-apply never moves the host, so say so instead of ignoring them.
    const wantsOrg = options.org ?? existing.org_slug;
    const wantsWorkspace = options.workspace ?? existing.workspace_slug;
    if (
      wantsOrg !== existing.org_slug ||
      wantsWorkspace !== existing.workspace_slug
    ) {
      warnings.push(
        `this host reports to ${existing.org_slug}/${existing.workspace_slug}, not ${wantsOrg}/${wantsWorkspace}; run \`tacho reassign --org ${wantsOrg} --workspace ${wantsWorkspace}\` to move it, or pass --force to enroll again`,
      );
    }
    harnesses = existing.harnesses as TachoHarness[];
    host = existing;
    // A re-apply is the place a local override lands on a host that is already
    // enrolled: the value belongs to this machine, not to the enrollment, so
    // picking it up here saves a --force re-enrollment just to point tachod at
    // a local MCP server.
    const pinned = mcpEndpointOverrideFrom(deps.env);
    if (pinned !== undefined && pinned !== existing.mcp_endpoint_override) {
      host = { ...existing, mcp_endpoint_override: pinned };
      writeHostFile(deps.paths.hostFile, host);
      deps.out(`      MCP endpoint pinned to ${pinned} (TACHO_MCP_ENDPOINT)`);
    }
  } else {
    // The hook command and the service unit carry this binary's directory
    // verbatim; refuse before anything is revoked or minted when that
    // directory is gone after this launch (an AppImage mount, a mounted
    // .dmg, App Translocation). Step 6's health probe would pass while the
    // mount is up and every hook would fail to spawn afterwards.
    if (deps.runtime.transient !== undefined) {
      deps.err(
        `tacho is running from ${deps.runtime.transient} (${deps.runtime.binDir}), which is gone once it is closed; hooks and the service written from here would stop working. ` +
          (deps.platform === "darwin"
            ? "Move Oxagen to /Applications (or run the app's Link into PATH, which keeps a copy of the tools) and enroll again, or point TACHO_BIN_DIR at a permanent copy of tacho."
            : "Install the package (.deb/.rpm) or run the app's Link into PATH, which keeps a copy of the tools, and enroll again; or point TACHO_BIN_DIR at a permanent copy of tacho."),
      );
      return { ok: false, warnings };
    }
    // The token path carries its own credential; the operator path needs the
    // CLI's session and a picked org and workspace.
    let credentials:
      | { token: string; org: string; workspace: string; apiUrl: string }
      | undefined;
    const apiUrl = resolveApiUrl(options, deps.env, deps.home);
    if (options.enrollmentToken !== undefined) {
      step(1, "Presenting the one-time enrollment token");
    } else {
      step(1, "Authenticating with Oxagen");
      // A harness addition stays in the host's own org and workspace: the
      // token may come from flags, env or config.json, the pair may not.
      const resolved = resolveCredentials(
        live
          ? {
              ...options,
              org: existing.org_slug,
              workspace: existing.workspace_slug,
              apiUrl: options.apiUrl ?? existing.api_url,
            }
          : options,
        deps.env,
        deps.home,
      );
      if ("missing" in resolved) {
        deps.err(
          `Not logged in. Provide ${resolved.missing.join(", ")} or run \`oxagen login\` first.`,
        );
        return { ok: false, warnings };
      }
      credentials = resolved.credentials;
    }
    const managed =
      options.managed === true ||
      options.printManaged === true ||
      (live && existing.managed);
    if (live) {
      // Adding a harness revokes the live enrollment first, which takes the
      // CLI's session; a one-time token cannot revoke.
      if (credentials === undefined) {
        deps.err(
          "Adding a harness to an enrolled host needs the CLI's session: run `oxagen login` and enroll again. A one-time token enrolls an agent that has no live host, so to use one here, revoke this host first (`oxagen login`, then `tacho unenroll`, or revoke it from the fleet page) and enroll with a new token.",
        );
        return { ok: false, warnings };
      }
      harnesses = [...(existing.harnesses as TachoHarness[]), ...added];
      deps.out(
        `      adding ${added.join(", ")} to ${existing.agent_key}: revoking ${existing.host_enrollment_id} and enrolling again for ${harnesses.join(", ")} so the control plane's host record follows (device key, port and local token kept)`,
      );
      await revokeAndMark(
        existing,
        {
          token: credentials.token,
          reason: `tacho enroll --harness ${harnesses.join(",")}`,
        },
        deps,
        warnings,
      );
      stripEnrollmentHooks(existing, deps);
    }

    step(2, `Generating the host device key at ${deps.paths.deviceKey}`);
    ensureDir(deps.paths.root);
    const { key, created } = loadOrCreateDeviceKey(deps.paths.deviceKey);
    deps.out(
      `      ${created ? "created" : "reusing"} ed25519 key ${key.fingerprint}`,
    );

    const claude = deps.claude();
    const codex = harnesses.includes("codex") ? deps.codex() : {};
    const stella = harnesses.includes("stella") ? deps.stella() : {};
    step(
      3,
      credentials
        ? `Enrolling ${deps.hostname} in ${credentials.org}/${credentials.workspace} for ${harnesses.join(", ")}`
        : `Enrolling ${deps.hostname} for ${harnesses.join(", ")}`,
    );
    const facts = {
      hostname: deps.hostname,
      osUser: deps.osUser,
      platform: deps.platform,
      osVersion: deps.osVersion,
      arch: deps.arch,
      devicePublicKey: key.publicKey,
      harnesses,
      ...(claude.version !== undefined
        ? { claudeVersion: claude.version }
        : {}),
      ...(claude.path !== undefined ? { claudeExecpath: claude.path } : {}),
      nodeVersion: deps.nodeVersion,
      wrapperVersion: deps.wrapperVersion,
      ...(deps.env["SHELL"] !== undefined ? { shell: deps.env["SHELL"] } : {}),
      managed,
      validityDays: options.validityDays ?? 180,
    };
    let response: Awaited<ReturnType<typeof callEnrollment>>;
    let tenant: { orgSlug: string; workspaceSlug: string };
    try {
      if (credentials) {
        response = await callEnrollment(deps, credentials, facts);
        tenant = {
          orgSlug: credentials.org,
          workspaceSlug: credentials.workspace,
        };
      } else {
        const remote = repositoryRemote(deps);
        const answer = await callTokenEnrollment(deps, apiUrl, {
          token: options.enrollmentToken,
          ...facts,
          ...(remote !== undefined ? { repositoryRemote: remote } : {}),
        });
        response = answer;
        tenant = {
          orgSlug: answer.orgSlug,
          workspaceSlug: answer.workspaceSlug,
        };
      }
    } catch (error) {
      if (
        credentials &&
        error instanceof ControlError &&
        (error.status === 401 || error.status === 403)
      ) {
        // 401 and 403 need different fixes, and the server's reason is the
        // only thing that tells a person which check refused them.
        const reason = controlErrorReason(error.body);
        deps.err(
          error.status === 401
            ? `Oxagen refused the enrollment (401)${reason}: your token is invalid or expired. Run \`oxagen login\` and enroll again.`
            : `Oxagen refused the enrollment (403)${reason}: your token cannot create Tacho enrollments in ${credentials.org}/${credentials.workspace}. Enrolling a host takes an org Owner or Admin; run \`oxagen login\` as one and enroll again.`,
        );
      } else if (
        !credentials &&
        error instanceof ControlError &&
        (error.status === 404 || error.status === 409)
      ) {
        // enroll_host: an unknown token is 404; a used or expired one is 409
        // (single use), and the body names which.
        deps.err(
          `Oxagen rejected the enrollment token (${error.status}): ${error.body.slice(0, 256)}. Issue a new token from the Agents page or \`oxagen agent register\`.`,
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
    const mcpEndpointOverride =
      mcpEndpointOverrideFrom(deps.env) ?? existing?.mcp_endpoint_override;
    if (
      mcpEndpointOverride === undefined &&
      (deps.env["TACHO_MCP_ENDPOINT"] ?? "") !== ""
    ) {
      warnings.push(
        `TACHO_MCP_ENDPOINT is not a URL (${deps.env["TACHO_MCP_ENDPOINT"] ?? ""}); ignoring it rather than writing a host.json that will not load`,
      );
      deps.err(`      ${warnings[warnings.length - 1] ?? ""}`);
    }
    host = {
      schema: HOST_FILE_SCHEMA,
      host_enrollment_id: response.hostEnrollmentId,
      agent_key: response.agentKey,
      organization_id: response.enrollment.claims.organization_id,
      workspace_id: response.enrollment.claims.workspace_id,
      org_slug: tenant.orgSlug,
      workspace_slug: tenant.workspaceSlug,
      api_url: apiUrl,
      api_key: response.apiKey,
      api_key_public_id: response.apiKeyPublicId,
      ...(response.gatewayApiKey !== undefined
        ? { gateway_api_key: response.gatewayApiKey }
        : {}),
      ...(response.gatewayApiKeyPublicId !== undefined
        ? { gateway_api_key_public_id: response.gatewayApiKeyPublicId }
        : {}),
      endpoints: {
        ingest: response.enrollment.claims.ingest_endpoint,
        bundle: response.enrollment.claims.bundle_endpoint,
        commands: response.enrollment.claims.commands_endpoint,
        ...(response.enrollment.claims.mcp_endpoint !== undefined
          ? { mcp: response.enrollment.claims.mcp_endpoint }
          : {}),
      },
      // The service unit tachod runs under carries only TACHO_HOME,
      // CLAUDE_CONFIG_DIR, PATH and HOME, so TACHO_MCP_ENDPOINT as exported in
      // this shell would not survive the install. Write it down instead —
      // beside `port` and `local_token`, the host's other local settings — and
      // leave the signed claims free of plaintext endpoints.
      ...(mcpEndpointOverride === undefined
        ? {}
        : { mcp_endpoint_override: mcpEndpointOverride }),
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
      harnesses,
      managed: managed,
      claude_version: claude.version ?? null,
      claude_execpath: claude.path ?? null,
      ...(harnesses.includes("codex")
        ? {
            codex_version: codex.version ?? null,
            codex_execpath: codex.path ?? null,
          }
        : {}),
      ...(harnesses.includes("stella")
        ? {
            stella_version: stella.version ?? null,
            stella_execpath: stella.path ?? null,
          }
        : {}),
      wrapper_version: deps.wrapperVersion,
      hook_command: deps.runtime.hookCommand,
      daemon_command: deps.runtime.daemonCommand,
      // Carried across a re-enrollment, not reset. These are the operator's
      // own values that a previous enroll moved aside; `unenroll` is what
      // puts them back, and a `--force` re-enroll that blanked them would
      // strand an env value and an MCP server nobody could restore.
      displaced_env: existing?.displaced_env ?? {},
      displaced_mcp_servers: existing?.displaced_mcp_servers ?? {},
      mcp_stdio_command: deps.runtime.mcpStdioCommand,
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
    step(5, `Writing hooks for ${harnesses.join(", ")}`);
    if (harnesses.includes("claude-code")) {
      deps.out(`      Claude Code: ${deps.paths.claudeSettings}`);
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
    }
    if (harnesses.includes("codex")) {
      deps.out(`      Codex: ${deps.paths.codexHooks}`);
      const merged = mergeCodexHooks(deps.readCodexHooks(), hookConfig);
      if (merged.changed) {
        deps.writeCodexHooks(merged.settings);
        deps.out(
          `      hooks written for ${codexHookPresence(merged.settings, host.host_enrollment_id).present.length} events (command hooks; Codex has no OTel export)`,
        );
      } else {
        deps.out("      already present; nothing to change");
      }
    }
    if (harnesses.includes("stella")) {
      const file = deps.readStellaHooks();
      deps.out(`      Stella: ${file.path}`);
      const merged = mergeStellaHooks(file, hookConfig);
      if (!merged.ok) {
        // Nothing is written: a stella.toml Stella cannot parse would stop
        // every Stella session, which is worse than an unhooked one.
        warnings.push(`Stella hooks not written: ${merged.error}`);
        deps.out("      not written (see the warning below)");
      } else if (merged.changed) {
        deps.writeStellaHooks(merged.file);
        deps.out(
          `      hooks written for ${stellaHookPresence(merged.file, host.host_enrollment_id).present.length} events (${file.format === "toml" ? "a managed block at the end of stella.toml; the rest of the file is untouched" : "command hooks in settings.json"}; Stella has no SessionEnd, so tachod seals a session when the stella process exits)`,
        );
      } else {
        deps.out("      already present; nothing to change");
      }
    }
    if (harnesses.includes("claude-desktop")) {
      // The connected tier (ADR-078). No hooks: Claude Desktop has no hook
      // surface, so what is written is one MCP server entry pointing at the
      // collector's loopback gateway, and what Oxagen can govern is the
      // toolbelt it serves through it.
      const path = deps.paths.claudeDesktopConfig;
      if (path === undefined) {
        warnings.push(
          "Claude Desktop is not written on this platform: Anthropic ships no build for it, so there is no config for Oxagen to write",
        );
        deps.out("      Claude Desktop: not available on this platform");
      } else {
        deps.out(`      Claude Desktop: ${path}`);
        const merged = mergeClaudeDesktopConfig(
          deps.readClaudeDesktopConfig(),
          {
            enrollmentId: host.host_enrollment_id,
            port: host.port,
            localToken: host.local_token,
            shimCommand: deps.runtime.mcpStdioCommand[0] as string,
            shimArgs: deps.runtime.mcpStdioCommand.slice(1, -1),
            ...(deps.env["TACHO_HOME"] !== undefined
              ? { tachoHome: deps.env["TACHO_HOME"] }
              : {}),
          },
        );
        if (merged.changed) {
          deps.writeClaudeDesktopConfig(merged.config);
          if (Object.keys(merged.displaced).length > 0) {
            host = {
              ...host,
              displaced_mcp_servers: {
                ...host.displaced_mcp_servers,
                "claude-desktop": merged.displaced as Record<
                  string,
                  Record<string, unknown>
                >,
              },
            };
            writeHostFile(deps.paths.hostFile, host);
            warnings.push(
              "an MCP server already used the name `oxagen` in Claude Desktop; it was moved aside and unenroll restores it",
            );
          }
          deps.out(`      ${CLAUDE_DESKTOP_RESTART_NOTE}`);
        } else {
          deps.out("      already present; nothing to change");
        }
        const presence = claudeDesktopPresence(
          deps.readClaudeDesktopConfig(),
          host.host_enrollment_id,
        );
        if (presence.otherServers > 0) {
          // ADR-078 §3: the operator is entitled to the size of the gap. A
          // tool served by another MCP server never reaches Oxagen, and no
          // code here can change that.
          deps.out(
            `      ${presence.otherServers} other MCP server${presence.otherServers === 1 ? "" : "s"} in this app (${presence.otherServerNames.join(", ")}); Oxagen does not see what they serve`,
          );
        }
      }
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
  // Only the harnesses this host hooks: a Codex- or Stella-only host has no
  // reason to hear that `claude` is missing.
  if (harnesses.includes("claude-code")) {
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
  }
  if (harnesses.includes("codex")) {
    const codex = deps.codex();
    if (codex.path === undefined)
      warnings.push(
        "`codex` is not on PATH; hooks will apply once it is installed",
      );
    else deps.out(`      codex ${codex.version ?? "?"} at ${codex.path}`);
  }
  if (harnesses.includes("stella")) {
    const stella = deps.stella();
    if (stella.path === undefined)
      warnings.push(
        "`stella` is not on PATH; hooks will apply once it is installed",
      );
    else deps.out(`      stella ${stella.version ?? "?"} at ${stella.path}`);
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
        deps.platform === "win32"
          ? `      tachod healthy on 127.0.0.1:${host.port}`
          : `      tachod healthy on 127.0.0.1:${host.port} and ${deps.paths.socket}`,
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
    `Done. This machine reports to Oxagen as ${host.agent_key}; every ${listLabels(harnesses)} session from now on is recorded${host.bundle.mode === "enforce" ? " and gated" : " (observe mode)"}.`,
  );
  return {
    ok: true,
    host,
    ...(managedSettings !== undefined ? { managedSettings } : {}),
    warnings,
  };
}
