/**
 * Human-handle → public-id resolution for the env + secret commands. Lets users
 * type environment slugs and secret key names while the API works in public ids.
 * A value already shaped like a public id (env_… / sk_…) passes through.
 */
import { apiPost } from "./api.js";

interface EnvSummary {
  id: string;
  slug: string;
}
interface KeySummary {
  id: string;
  key: string;
}

export async function resolveEnvironmentId(slugOrId: string): Promise<string> {
  if (slugOrId.startsWith("env_")) return slugOrId;
  const { environments } = await apiPost<{ environments: EnvSummary[] }>(
    "environment/list",
    {},
  );
  const match = environments.find((e) => e.slug === slugOrId.toLowerCase());
  if (!match) {
    process.stderr.write(`No environment with slug '${slugOrId}'.\n`);
    process.exit(1);
  }
  return match.id;
}

export async function resolveSecretKeyId(nameOrId: string): Promise<string> {
  if (nameOrId.startsWith("sk_")) return nameOrId;
  const { keys } = await apiPost<{ keys: KeySummary[] }>("secret/key/list", {});
  const match = keys.find((k) => k.key === nameOrId);
  if (!match) {
    process.stderr.write(`No secret key named '${nameOrId}'.\n`);
    process.exit(1);
  }
  return match.id;
}
