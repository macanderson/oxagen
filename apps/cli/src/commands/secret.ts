/** `oxagen secret …` — manage the workspace credential vault via the API. */
import { readFileSync } from "fs";
import { apiPost, printTable } from "../lib/api.js";
import { resolveEnvironmentId, resolveSecretKeyId } from "../lib/resolve.js";

interface KeySummary {
  id: string;
  key: string;
  sensitive: boolean;
  memo: string | null;
  hasDefault: boolean;
  overrideEnvironmentIds: string[];
}

interface ImportRow {
  key: string;
  isNewKey: boolean;
  sensitive: boolean;
  target: "default" | "override";
  willOverride: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleSecretList(opts: {
  json?: boolean;
}): Promise<void> {
  const { keys } = await apiPost<{ keys: KeySummary[] }>("secret/key/list", {});
  if (opts.json) {
    process.stdout.write(JSON.stringify(keys, null, 2) + "\n");
    return;
  }
  printTable(
    ["KEY", "SENS", "DEFAULT", "OVERRIDES", "MEMO"],
    keys.map((k) => [
      k.key,
      k.sensitive ? "●" : "○",
      k.hasDefault ? "yes" : "—",
      String(k.overrideEnvironmentIds.length),
      k.memo ?? "",
    ]),
  );
}

export async function handleSecretSet(
  key: string,
  value: string,
  opts: { env?: string; sensitive?: boolean },
): Promise<void> {
  const sensitive = opts.sensitive ?? true;
  if (opts.env) {
    // Ensure the key exists (preserving sensitivity), then set the override.
    await apiPost<{ id: string }>("secret/key/upsert", { key, sensitive });
    const keyId = await resolveSecretKeyId(key);
    const environmentId = await resolveEnvironmentId(opts.env);
    await apiPost<{ ok: boolean }>("secret/value/set", {
      keyId,
      environmentId,
      value,
    });
    process.stdout.write(
      `✓ key ${key} (${sensitive ? "sensitive" : "plain"}) · override set for ${opts.env}\n`,
    );
  } else {
    await apiPost<{ id: string }>("secret/key/upsert", {
      key,
      sensitive,
      defaultValue: value,
    });
    process.stdout.write(
      `✓ key ${key} (${sensitive ? "sensitive" : "plain"}) · default value set\n`,
    );
  }
}

export async function handleSecretRemove(
  key: string,
  opts: { env?: string },
): Promise<void> {
  const keyId = await resolveSecretKeyId(key);
  if (opts.env) {
    const environmentId = await resolveEnvironmentId(opts.env);
    await apiPost<{ ok: boolean }>("secret/value/unset", {
      keyId,
      environmentId,
    });
    process.stdout.write(`✓ removed override of ${key} for ${opts.env}\n`);
  } else {
    await apiPost<{ ok: boolean }>("secret/key/delete", { keyId });
    process.stdout.write(`✓ removed key ${key}\n`);
  }
}

export async function handleSecretReveal(
  key: string,
  opts: { env?: string },
): Promise<void> {
  const keyId = await resolveSecretKeyId(key);
  const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : null;
  const { value, source } = await apiPost<{
    key: string;
    value: string | null;
    source: string;
  }>("secret/reveal", { keyId, environmentId });
  process.stderr.write("⚠ access recorded (actor, time)\n");
  process.stdout.write(value === null ? `‹unset›\n` : `${value}\n`);
  if (source === "unset")
    process.stderr.write("(no override and no default)\n");
}

export async function handleSecretImport(opts: {
  env?: string;
  file?: string;
  yes?: boolean;
}): Promise<void> {
  const text = opts.file ? readFileSync(opts.file, "utf8") : await readStdin();
  const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : null;
  const { rows, committed } = await apiPost<{
    rows: ImportRow[];
    committed: boolean;
  }>("secret/import-env", { text, environmentId, commit: !!opts.yes });
  const newCount = rows.filter((r) => r.isNewKey).length;
  process.stdout.write(
    `${committed ? "imported" : "preview"} — ${rows.length} parsed (${newCount} new, ${rows.length - newCount} existing):\n`,
  );
  printTable(
    ["", "KEY", "TARGET", "SENS", "STATE"],
    rows.map((r) => [
      r.isNewKey ? "+" : "~",
      r.key,
      r.target,
      r.sensitive ? "●" : "○",
      r.isNewKey ? "new" : r.willOverride ? "override" : "set",
    ]),
  );
  if (!committed) process.stdout.write("rerun with --yes to apply\n");
}

export async function handleSecretExport(opts: {
  env?: string;
  out?: string;
}): Promise<void> {
  const environmentId = opts.env ? await resolveEnvironmentId(opts.env) : null;
  const { dotenv, env } = await apiPost<{
    dotenv: string;
    env: Array<{ key: string }>;
  }>("secret/export", { environmentId });
  process.stderr.write("⚠ access recorded (actor, time)\n");
  if (opts.out) {
    const { writeFileSync } = await import("fs");
    writeFileSync(opts.out, dotenv, "utf8");
    process.stdout.write(`✓ wrote ${env.length} key(s) to ${opts.out}\n`);
  } else {
    process.stdout.write(dotenv);
  }
}
