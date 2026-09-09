/**
 * `oxagen agent env …` — bind agents to environments over the org-scoped /v1
 * API (Spec §8). Thin shells over the agent.environment.* capabilities so the
 * CLI stays in parity with the API, MCP, and agent surfaces.
 *
 * Verbs: bind <agent> --env <slug> [--primary], unbind <agent> --env <slug>,
 * list <agent> (--json). The sandbox-template half of a binding went with the
 * runtime (ADR-043) — an environment is now a governed configuration record,
 * not an execution target.
 *
 * Agent addressing mirrors the rest of the platform: the `<agent>` argument is
 * an agent's public id (`agt_…`) or a slug / agent-key, resolved to its public
 * id via the agent-definition list (its `agentId` field IS the public id — see
 * agent.definition.list handler). That public id is exactly what the app passes
 * as `agentId` when it binds, so a CLI-created binding is the same row.
 *
 * Output discipline (ADR-023 §4, via createOutput): stdout carries only the
 * result; progress/warnings go to stderr; every failure is a uniform `✗ …`.
 */
import {
  apiGetOrThrow,
  apiPostOrThrow,
  ApiError,
  printTable,
} from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

interface EnvSummary {
  id: string;
  slug: string;
}

interface AgentDefSummary {
  agentId: string; // public id (agt_…), per agent.definition.list
  slug: string;
  agentKey: string | null;
}

interface AgentEnvironmentBinding {
  id: string;
  agentId: string;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  isPrimary: boolean;
}

// ── handle → public-id resolution ───────────────────────────────────────────

async function resolveAgentId(handle: string): Promise<string> {
  if (handle.startsWith("agt_")) return handle;
  const { agents } = await apiGetOrThrow<{ agents: AgentDefSummary[] }>(
    "agent/definitions",
  );
  const lower = handle.toLowerCase();
  const match = agents.find(
    (a) =>
      a.agentId === handle ||
      a.slug.toLowerCase() === lower ||
      (a.agentKey !== null && a.agentKey.toLowerCase() === lower),
  );
  if (!match)
    throw new ApiError(
      `No agent matching '${handle}' (by public id, slug, or agent key).`,
    );
  return match.agentId;
}

async function resolveEnvironmentId(slugOrId: string): Promise<string> {
  if (slugOrId.startsWith("env_")) return slugOrId;
  const { environments } = await apiPostOrThrow<{ environments: EnvSummary[] }>(
    "environment/list",
    {},
  );
  const match = environments.find(
    (e) => e.slug.toLowerCase() === slugOrId.toLowerCase(),
  );
  if (!match) throw new ApiError(`No environment with slug '${slugOrId}'.`);
  return match.id;
}

// ── bind ─────────────────────────────────────────────────────────────────────

export async function handleAgentEnvBind(
  agentHandle: string,
  opts: { env?: string; primary?: boolean; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (!opts.env) {
    process.exitCode = 2;
    out.error("bind requires --env <environment slug|id>.", "usage");
    return;
  }
  try {
    const agentId = await resolveAgentId(agentHandle);
    const environmentId = await resolveEnvironmentId(opts.env);
    const body: Record<string, unknown> = { agentId, environmentId };
    if (opts.primary) body.isPrimary = true;
    const { binding } = await apiPostOrThrow<{
      binding: AgentEnvironmentBinding;
    }>("agent/environment/bind", body);
    out.data(
      binding,
      () =>
        `✓ bound ${agentHandle} → ${binding.environmentName} (${binding.environmentSlug})${binding.isPrimary ? " · primary" : ""}`,
    );
  } catch (err) {
    out.error(err, "api");
  }
}

// ── unbind ───────────────────────────────────────────────────────────────────

export async function handleAgentEnvUnbind(
  agentHandle: string,
  opts: { env?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  if (!opts.env) {
    process.exitCode = 2;
    out.error("unbind requires --env <environment slug|id>.", "usage");
    return;
  }
  try {
    const agentId = await resolveAgentId(agentHandle);
    const environmentId = await resolveEnvironmentId(opts.env);
    const res = await apiPostOrThrow<{ ok: boolean }>(
      "agent/environment/unbind",
      {
        agentId,
        environmentId,
      },
    );
    out.data(res, () => `✓ unbound ${agentHandle} from ${opts.env}`);
  } catch (err) {
    out.error(err, "api");
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

export async function handleAgentEnvList(
  agentHandle: string,
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  try {
    const agentId = await resolveAgentId(agentHandle);
    const { bindings } = await apiPostOrThrow<{
      bindings: AgentEnvironmentBinding[];
    }>("agent/environment/list", { agentId });
    out.data(bindings, () => renderBindings(bindings));
  } catch (err) {
    out.error(err, "api");
  }
}

function renderBindings(bindings: AgentEnvironmentBinding[]): string {
  if (bindings.length === 0) return "(no environment bindings)";
  const rows = bindings.map((b) => [
    b.environmentName,
    b.environmentSlug,
    b.isPrimary ? "★" : "",
  ]);
  const lines: string[] = [];
  printTable(["ENVIRONMENT", "SLUG", "PRIMARY"], rows, {
    write: (l) => void lines.push(l),
    writeErr: () => {},
  });
  return lines.join("\n");
}
