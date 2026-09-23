/**
 * `oxagen agent …` — the agent identity from the terminal (MC spec §14.1;
 * #2956). Every call goes through the org-scoped API client in lib/api.ts
 * with the key `oxagen login` minted; the API authenticates that key as the
 * user who approved the login (ADR-057 §4), so the handler role gates of
 * `register_agent` and `revoke_tacho_enrollment` see the same person the
 * console does.
 *
 *   oxagen agent register --slug <slug> --name <name> --harness <harness>
 *                         [--description <text>] [--validity-days <n>]
 *       register_agent: mints the identity and prints the credential once
 *   oxagen agent status <agent>
 *       get_agent: identity, credentials, roles, hosts, the definition of record
 *   oxagen agent unenroll <agent> [--host <tch_id>] [--reason <text>]
 *       revoke_tacho_enrollment for the named host, or every live host of the agent
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload
 * as one line on stdout; pretty mode renders tables; failures are uniform
 * stderr error lines (exit 2 for a bad flag, exit 1 for an API failure).
 */
import { apiPostOrThrow, printTable } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Wire shapes (mirror the agent.{register,get} and tacho.enrollment.revoke contracts) ──

const AGENT_HARNESSES = [
  "stella",
  "claude-code",
  "codex",
  "cursor",
  "claude-agent-sdk",
  "custom",
] as const;
type AgentHarness = (typeof AGENT_HARNESSES)[number];

export interface AgentRegisterResult {
  agentId: string;
  slug: string;
  agentKey: string | null;
  principalId: string;
  credential: { id: string; secret: string; expiresAt: string };
}

interface AgentCredential {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface AgentHost {
  hostEnrollmentId: string;
  hostname: string;
  platform: string;
  status: string;
  mode: string;
  harnesses: string[];
  collectorVersion: string | null;
  hooksOk: boolean | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AgentGetResult {
  identity: {
    id: string;
    slug: string;
    name: string;
    agentKey: string | null;
    harness: string;
    principalId: string | null;
    operatorId: string | null;
    status: string;
    registeredAt: string;
    firstFrameAt: string | null;
    costCenter: string | null;
  };
  credentials: AgentCredential[];
  roles: {
    id: string;
    name: string;
    scopeKind: string;
    expiresAt: string | null;
  }[];
  hosts: AgentHost[];
  definition: {
    version: number;
    path: string;
    digest: string;
    commitSha: string;
    branch: string;
    pullRequestUrl: string;
    committedAt: string;
  } | null;
}

interface TachoRevokeResult {
  hostEnrollmentId: string;
  status: "revoked";
  revokedAt: string;
}

const LIVE_HOST_STATUSES = new Set(["active", "paused", "suspended"]);

function isHarness(v: string): v is AgentHarness {
  return (AGENT_HARNESSES as readonly string[]).includes(v);
}

// ── agent register ────────────────────────────────────────────────────────

export interface AgentRegisterCliOptions {
  slug?: string;
  name?: string;
  harness?: string;
  description?: string;
  validityDays?: string;
  json?: boolean;
}

export async function agentRegister(
  opts: AgentRegisterCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (
    !opts.slug ||
    !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(opts.slug) ||
    opts.slug.length > 18
  ) {
    process.exitCode = 2;
    out.error(
      `Invalid --slug "${opts.slug ?? ""}". Use up to 18 lowercase letters, digits and hyphens.`,
      "usage",
    );
    return;
  }
  if (!opts.name) {
    process.exitCode = 2;
    out.error("--name is required.", "usage");
    return;
  }
  if (!opts.harness || !isHarness(opts.harness)) {
    process.exitCode = 2;
    out.error(
      `Invalid --harness "${opts.harness ?? ""}". Use one of ${AGENT_HARNESSES.join(", ")}.`,
      "usage",
    );
    return;
  }
  let validityDays: number | undefined;
  if (opts.validityDays !== undefined) {
    validityDays = Number(opts.validityDays);
    if (
      !Number.isInteger(validityDays) ||
      validityDays < 1 ||
      validityDays > 365
    ) {
      process.exitCode = 2;
      out.error(
        `Invalid --validity-days "${opts.validityDays}". Use an integer from 1 to 365.`,
        "usage",
      );
      return;
    }
  }

  let result: AgentRegisterResult;
  try {
    result = await apiPostOrThrow<AgentRegisterResult>("agents/register", {
      slug: opts.slug,
      name: opts.name,
      harness: opts.harness,
      ...(opts.description ? { description: opts.description } : {}),
      ...(validityDays !== undefined ? { validityDays } : {}),
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(`Registered ${result.slug} (${result.agentId}).`);
  writer.write(`  principal   ${result.principalId}`);
  writer.write(`  agent key   ${result.agentKey ?? "—"}`);
  writer.write("");
  writer.write("Credential (shown once; it cannot be recovered):");
  writer.write(`  ${result.credential.secret}`);
  writer.write(`  expires ${result.credential.expiresAt}`);
  writer.write("");
  writer.write(
    "Commit the definition to .oxagen/agents/" +
      `${result.slug}.toml and enroll a host with: oxagen tacho enroll`,
  );
}

// ── agent status ──────────────────────────────────────────────────────────

export async function agentStatus(
  agent: string,
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: AgentGetResult;
  try {
    result = await apiPostOrThrow<AgentGetResult>("agents/get", {
      agentId: agent,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  const { identity } = result;
  writer.write(`${identity.name} (${identity.slug}) — ${identity.status}`);
  writer.write(`  id          ${identity.id}`);
  writer.write(`  agent key   ${identity.agentKey ?? "—"}`);
  writer.write(`  harness     ${identity.harness}`);
  writer.write(`  principal   ${identity.principalId ?? "—"}`);
  writer.write(`  operator    ${identity.operatorId ?? "—"}`);
  writer.write(`  registered  ${identity.registeredAt}`);
  writer.write(`  first frame ${identity.firstFrameAt ?? "—"}`);
  writer.write(`  cost center ${identity.costCenter ?? "—"}`);
  writer.write("");
  writer.write("Credentials:");
  if (result.credentials.length === 0) writer.write("  none");
  else
    printTable(
      ["ID", "PREFIX", "EXPIRES", "LAST USED", "REVOKED"],
      result.credentials.map((c) => [
        c.id,
        c.prefix,
        c.expiresAt ?? "—",
        c.lastUsedAt ?? "—",
        c.revokedAt ?? "—",
      ]),
      writer,
    );
  writer.write("");
  writer.write("Roles:");
  if (result.roles.length === 0) writer.write("  none");
  else
    printTable(
      ["ROLE", "SCOPE", "EXPIRES"],
      result.roles.map((r) => [r.name, r.scopeKind, r.expiresAt ?? "—"]),
      writer,
    );
  writer.write("");
  writer.write("Hosts:");
  if (result.hosts.length === 0) writer.write("  none (oxagen tacho enroll)");
  else
    printTable(
      ["HOST", "HOSTNAME", "STATUS", "MODE", "HOOKS", "LAST SEEN"],
      result.hosts.map((h) => [
        h.hostEnrollmentId,
        h.hostname,
        h.status,
        h.mode,
        h.hooksOk === null ? "—" : h.hooksOk ? "ok" : "missing",
        h.lastSeenAt ?? "—",
      ]),
      writer,
    );
  writer.write("");
  if (result.definition === null) {
    writer.write("Definition: none committed");
  } else {
    const d = result.definition;
    writer.write(
      `Definition: ${d.path} @ ${d.commitSha.slice(0, 12)} on ${d.branch} (v${d.version})`,
    );
    writer.write(`  ${d.pullRequestUrl}`);
  }
}

// ── agent unenroll ────────────────────────────────────────────────────────

export interface AgentUnenrollCliOptions {
  host?: string;
  reason?: string;
  json?: boolean;
}

export async function agentUnenroll(
  agent: string,
  opts: AgentUnenrollCliOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (opts.host !== undefined && !/^tch_[0-9a-z]+$/.test(opts.host)) {
    process.exitCode = 2;
    out.error(
      `Invalid --host "${opts.host}". Use the host's tch_ id.`,
      "usage",
    );
    return;
  }
  let current: AgentGetResult;
  try {
    current = await apiPostOrThrow<AgentGetResult>("agents/get", {
      agentId: agent,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  const live = current.hosts.filter((h) => LIVE_HOST_STATUSES.has(h.status));
  const targets =
    opts.host === undefined
      ? live
      : live.filter((h) => h.hostEnrollmentId === opts.host);
  if (opts.host !== undefined && targets.length === 0) {
    process.exitCode = 2;
    out.error(
      `${opts.host} is not a live host of ${current.identity.slug}.`,
      "usage",
    );
    return;
  }
  const revoked: TachoRevokeResult[] = [];
  for (const host of targets) {
    try {
      revoked.push(
        await apiPostOrThrow<TachoRevokeResult>("tacho/enrollments/revoke", {
          hostEnrollmentId: host.hostEnrollmentId,
          ...(opts.reason ? { reason: opts.reason } : {}),
        }),
      );
    } catch (err) {
      out.error(err, "api");
      return;
    }
  }
  if (out.isJson) {
    out.data({ agentId: current.identity.id, revoked });
    return;
  }
  if (revoked.length === 0) {
    writer.write(`${current.identity.slug} has no live host to unenroll.`);
    return;
  }
  for (const r of revoked) {
    writer.write(`Revoked ${r.hostEnrollmentId} at ${r.revokedAt}.`);
  }
}
