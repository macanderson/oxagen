// Pure reconciliation logic, kept separate from the gcloud-driving pull script
// so it can be unit-tested without side effects.
//
// Two jobs:
//   - parseEnvFile: read creds.txt (markdown `- KEY=value` bullets) and .env.local
//     (standard `KEY=value`) into an upper-cased key→value map.
//   - reconcile: pick the freshest value for a GCP secret. creds.txt is the named
//     source of truth, but its values are LOCAL/DEV, so it only overrides
//     unsuffixed/dev secrets — never a -production/-staging GCP variant.
import { readFileSync } from "node:fs";
import type { ValueSource } from "./secrets-db";
import { canonicalize } from "./secrets-meta";

/** Parse `KEY=value` and `- KEY=value` lines into an upper-cased key map. */
export function parseEnvFile(path: string): Map<string, string> {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  return parseEnvText(text);
}

/** The string-parsing core of parseEnvFile (testable without the filesystem). */
export function parseEnvText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^\s*-\s*/, "").trim(); // strip markdown bullet
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    map.set(key.toUpperCase(), value);
  }
  return map;
}

/** GCP secrets whose values are stage-specific and must not take a dev override. */
export const STAGE_SUFFIX =
  /-(production|staging|sandbox|prod)$|-public-(staging|production)$/;

export interface Reconciled {
  value: string | null;
  source: ValueSource;
  isDuplicate: boolean;
}

/**
 * Decide the freshest value. creds.txt wins for unsuffixed/dev secrets; for
 * -production/-staging variants the GCP value is authoritative even though the
 * duplicate is still flagged. .env.local fills gaps GCP can't.
 */
export function reconcile(
  gcpName: string,
  envKey: string | null,
  gcpValue: string | null,
  creds: Map<string, string>,
  envLocal: Map<string, string>,
): Reconciled {
  // Try the resolved env key, the canonicalized name (drops oxagen-/env suffix),
  // and the raw upper-snake name — so duplicates are caught even when GCP and the
  // repo disagree on naming.
  const lookups = [
    envKey?.toUpperCase(),
    canonicalize(gcpName),
    gcpName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase(),
  ].filter((x): x is string => Boolean(x));
  const find = (m: Map<string, string>) =>
    lookups.map((k) => m.get(k)).find((v) => v && v.length > 0) ?? null;

  const credsVal = find(creds);
  const envVal = find(envLocal);
  const isStage = STAGE_SUFFIX.test(gcpName);
  const isDuplicate = Boolean(credsVal || envVal);

  if (credsVal && !isStage)
    return { value: credsVal, source: "creds.txt", isDuplicate };
  if (gcpValue !== null) return { value: gcpValue, source: "gcp", isDuplicate };
  if (credsVal) return { value: credsVal, source: "creds.txt", isDuplicate };
  if (envVal) return { value: envVal, source: ".env.local", isDuplicate };
  return { value: null, source: "missing", isDuplicate };
}
