import type { EnvName } from "@oxagen/config";
import type { Config } from "./config";
import type { VercelEnvVar } from "./types";

const BASE = "https://api.vercel.com";

function headers(cfg: Config): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.vercelToken}`,
    "Content-Type": "application/json",
  };
}

export async function listEnv(
  cfg: Config,
  projectId: string,
): Promise<VercelEnvVar[]> {
  const res = await fetch(
    `${BASE}/v9/projects/${projectId}/env?teamId=${cfg.teamId}`,
    {
      headers: headers(cfg),
    },
  );
  if (!res.ok)
    throw new Error(`listEnv ${projectId}: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { envs?: VercelEnvVar[] };
  return json.envs ?? [];
}

// Vercel's upsert updates the matching key and target without a prior delete.
// https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
export async function upsertEnv(
  cfg: Config,
  projectId: string,
  key: string,
  value: string,
  target: EnvName,
  secret: boolean,
): Promise<void> {
  const res = await fetch(
    `${BASE}/v10/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(cfg.teamId)}&upsert=true`,
    {
      method: "POST",
      headers: headers(cfg),
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        key,
        value,
        type: secret ? "encrypted" : "plain",
        target: [target],
      }),
    },
  );
  if (!res.ok) throw new Error(`upsert ${key}/${target}: HTTP ${res.status}`);
  let result: { failed?: unknown[] } | null;
  try {
    result = (await res.json()) as { failed?: unknown[] } | null;
  } catch {
    throw new Error(`upsert ${key}/${target}: invalid provider response`);
  }
  if (Array.isArray(result?.failed) && result.failed.length > 0) {
    throw new Error(`upsert ${key}/${target}: provider refused the update`);
  }
}
