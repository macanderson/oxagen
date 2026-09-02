/**
 * `oxagen a2a card` — print this workspace's A2A (Agent2Agent) protocol Agent
 * Card: the discovery document advertising the workspace's exposed agents as
 * A2A skills, the JSON-RPC transport endpoint, and the auth scheme. This is the
 * CLI parity surface for the a2a.card.get capability; it reads through the
 * governed (metered, IAM-gated) /v1 API rather than hitting the graph directly.
 *
 * Output discipline (ADR-023 §4): `--json` emits one single-line JSON value on
 * stdout; pretty mode renders the human card on stdout; every failure is a
 * uniform stderr error line with exit code 1 (and nothing on stdout).
 */
import {
  getApiUrl,
  getOrgId,
  getWorkspaceId,
  getToken,
} from "../lib/config.js";
import { createOutput, errorMessage } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface A2ACardOptions {
  json?: boolean;
}

interface A2ACard {
  name: string;
  description: string;
  url: string;
  protocolVersion: string;
  skills: { id: string; name: string; description: string }[];
}

export async function handleA2ACard(
  opts: A2ACardOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const org = getOrgId();
  const workspace = getWorkspaceId();
  const token = getToken();

  if (!org || !workspace) {
    out.error(
      "Missing org or workspace. Run `oxagen config` or set OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.",
      "config",
    );
    return;
  }
  if (!token) {
    out.error("Not authenticated. Run `oxagen login` first.", "auth");
    return;
  }

  const url = `${getApiUrl()}/v1/${org}/${workspace}/a2a/card`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (err) {
    out.error(`Failed to reach the API: ${errorMessage(err)}`, "network");
    return;
  }

  if (!res.ok) {
    out.error(
      `Failed to fetch A2A card (HTTP ${res.status}). ${await res.text()}`,
      "http",
    );
    return;
  }

  const card = (await res.json()) as A2ACard;
  out.data(card, () => prettyCard(card));
}

function prettyCard(card: A2ACard): string {
  return [
    card.name,
    card.description,
    "",
    `A2A protocol: ${card.protocolVersion}`,
    `Endpoint:     ${card.url}`,
    `Well-known:   ${getApiUrl()}/.well-known/agent-card.json`,
    "",
    `Skills (${card.skills.length}):`,
    ...card.skills.map((s) => `  • ${s.name} (${s.id}) — ${s.description}`),
  ].join("\n");
}
