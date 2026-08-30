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

// Create-or-replace a var for one (project, target). We delete any existing
// all-branches entry for the key+target first (Vercel rejects duplicate POSTs,
// and its CLI can't set "all preview branches" non-interactively), then POST a
// fresh value scoped to all branches of that target.
//
// This is NOT atomic and Vercel offers no transaction: if the POST fails after
// the DELETE succeeded, the variable is left *absent* from the project rather
// than reverted to its previous value. The old value is unrecoverable from
// here — Vercel does not return decrypted values — so the caller must treat a
// failed upsert of a secret var as "this key now needs to be re-pushed".
export async function upsertEnv(
  cfg: Config,
  projectId: string,
  key: string,
  value: string,
  target: EnvName,
  secret: boolean,
): Promise<void> {
  const existing = (await listEnv(cfg, projectId)).filter(
    (e) => e.key === key && e.target.includes(target) && !e.gitBranch,
  );
  for (const e of existing) {
    const del = await fetch(
      `${BASE}/v10/projects/${projectId}/env/${e.id}?teamId=${cfg.teamId}`,
      {
        method: "DELETE",
        headers: headers(cfg),
      },
    );
    if (!del.ok)
      throw new Error(
        `delete ${key}/${target}: ${del.status} ${await del.text()}`,
      );
  }
  const res = await fetch(
    `${BASE}/v10/projects/${projectId}/env?teamId=${cfg.teamId}`,
    {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({
        key,
        value,
        type: secret ? "encrypted" : "plain",
        target: [target],
      }),
    },
  );
  if (!res.ok)
    throw new Error(
      `upsert ${key}/${target}: ${res.status} ${await res.text()}`,
    );
}
