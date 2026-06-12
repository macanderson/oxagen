/**
 * pinEnvFile — make a dotenv file authoritative over inherited shell env.
 *
 * `tsx --env-file` / Node `--env-file` never override variables already
 * present in the environment, so a stale `export DATABASE_URL=...` in the
 * launching terminal silently retargets every spawned child. For the local
 * dev launcher that at best breaks migrate/seed on a dead host and at worst
 * points local dev at a remote database. The local stack's source of truth
 * is `.env.local`, so the launcher pins every key the file defines.
 */

import { parseEnv } from "node:util";

export interface EnvPinResult {
  /** Key → value assignments to apply to process.env. */
  assignments: Record<string, string>;
  /** Keys whose inherited value existed and differed from the file value. */
  overridden: string[];
}

/**
 * Pure core: given dotenv file content and the current environment, compute
 * the assignments that make the file authoritative and which inherited keys
 * those assignments override. Values are parsed with Node's dotenv rules
 * (quotes stripped, comments ignored).
 */
export function computeEnvPins(
  fileContent: string,
  currentEnv: Readonly<Record<string, string | undefined>>,
): EnvPinResult {
  const fileEnv = parseEnv(fileContent);
  const assignments: Record<string, string> = {};
  const overridden: string[] = [];

  for (const [key, value] of Object.entries(fileEnv)) {
    if (typeof value !== "string") continue;
    const inherited = currentEnv[key];
    if (inherited !== undefined && inherited !== value) {
      overridden.push(key);
    }
    assignments[key] = value;
  }

  return { assignments, overridden };
}
