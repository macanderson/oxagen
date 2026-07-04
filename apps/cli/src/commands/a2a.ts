/**
 * `oxagen a2a card` — print this workspace's A2A (Agent2Agent) protocol Agent
 * Card: the discovery document advertising the workspace's exposed agents as
 * A2A skills, the JSON-RPC transport endpoint, and the auth scheme. This is the
 * CLI parity surface for the a2a.card.get capability; it reads through the
 * governed (metered, IAM-gated) /v1 API rather than hitting the graph directly.
 */
import { getApiUrl, getOrgId, getWorkspaceId, getToken } from "../lib/config.js";

export interface A2ACardOptions {
  json?: boolean;
}

export async function handleA2ACard(opts: A2ACardOptions): Promise<void> {
  const org = getOrgId();
  const workspace = getWorkspaceId();
  const token = getToken();

  if (!org || !workspace) {
    process.stderr.write(
      "Missing org or workspace. Run `oxagen config` or set " +
        "OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!token) {
    process.stderr.write("Not authenticated. Run `oxagen login` first.\n");
    process.exitCode = 1;
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
    process.stderr.write(
      `Failed to reach the API: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!res.ok) {
    process.stderr.write(
      `Failed to fetch A2A card (HTTP ${res.status}). ${await res.text()}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const card = (await res.json()) as {
    name: string;
    description: string;
    url: string;
    protocolVersion: string;
    skills: { id: string; name: string; description: string }[];
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(card, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `${card.name}\n` +
      `${card.description}\n\n` +
      `A2A protocol: ${card.protocolVersion}\n` +
      `Endpoint:     ${card.url}\n` +
      `Well-known:   ${getApiUrl()}/.well-known/agent-card.json\n\n` +
      `Skills (${card.skills.length}):\n` +
      card.skills
        .map((s) => `  • ${s.name} (${s.id}) — ${s.description}`)
        .join("\n") +
      "\n",
  );
}
