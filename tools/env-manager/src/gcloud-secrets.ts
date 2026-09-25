// gcloud calls behind `pnpm env:secrets:pull`, kept apart from pull-secrets.ts
// so they can be tested without running the pull.
//
// Each lookup returns a result that separates "Secret Manager has nothing here"
// from "gcloud failed". An auth, permission, network, or quota failure must not
// read as an absent secret, or the pull would record the secret as missing and
// overwrite its last good row in secrets.db.
//
// Secret VALUES pass through stdout into memory only. Failure messages come from
// gcloud's stderr, which carries no value.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Runs `gcloud` with the given arguments and resolves with its stdout. */
export type GcloudRunner = (args: string[]) => Promise<{ stdout: string }>;

export const runGcloud: GcloudRunner = (args) =>
  execFileP("gcloud", args, { maxBuffer: 32 * 1024 * 1024 });

/** Why a lookup produced no value. */
export type GcloudFailureReason = "not_found" | "error";

export type GcloudResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: GcloudFailureReason; message: string };

interface GcloudVersion {
  name: string; // projects/P/secrets/S/versions/N
  createTime: string;
  state: string;
}

export interface ActiveVersion {
  version: string;
  createTime: string;
}

/**
 * Maps a failed gcloud call to a result. Only a NOT_FOUND status means the
 * secret or version is absent. Every other failure is an error the pull
 * reports.
 */
export function classifyGcloudFailure(err: unknown): {
  ok: false;
  reason: GcloudFailureReason;
  message: string;
} {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr =
    typeof e?.stderr === "string"
      ? e.stderr
      : Buffer.isBuffer(e?.stderr)
        ? e.stderr.toString("utf8")
        : "";
  const fallback =
    typeof e?.message === "string" ? e.message : String(err ?? "unknown error");
  const text = stderr.trim() || fallback;
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? text;
  const reason: GcloudFailureReason = /\bNOT_FOUND\b/.test(text)
    ? "not_found"
    : "error";
  return { ok: false, reason, message: firstLine };
}

async function gcloudJson<T>(
  run: GcloudRunner,
  project: string,
  args: string[],
): Promise<T> {
  const { stdout } = await run([
    ...args,
    "--format=json",
    "--project",
    project,
  ]);
  return JSON.parse(stdout) as T;
}

/** All secret names in the project. A failure throws: the pull cannot start. */
export async function listSecretNames(
  project: string,
  run: GcloudRunner = runGcloud,
): Promise<string[]> {
  const items = await gcloudJson<{ name: string }[]>(run, project, [
    "secrets",
    "list",
  ]);
  return items
    .map((i) => i.name.split("/").pop() ?? i.name)
    .sort((a, b) => a.localeCompare(b));
}

/** The newest enabled version of a secret (version number and createTime). */
export async function activeVersion(
  secret: string,
  project: string,
  run: GcloudRunner = runGcloud,
): Promise<GcloudResult<ActiveVersion>> {
  let versions: GcloudVersion[];
  try {
    versions = await gcloudJson<GcloudVersion[]>(run, project, [
      "secrets",
      "versions",
      "list",
      secret,
      "--filter=state=enabled",
      "--sort-by=~createTime",
      "--limit=1",
    ]);
  } catch (err) {
    return classifyGcloudFailure(err);
  }
  const v = versions[0];
  if (!v) {
    return { ok: false, reason: "not_found", message: "no enabled version" };
  }
  return {
    ok: true,
    value: {
      version: v.name.split("/").pop() ?? "?",
      createTime: v.createTime,
    },
  };
}

/** A specific version's value (raw stdout, never logged). */
export async function accessValue(
  secret: string,
  version: string,
  project: string,
  run: GcloudRunner = runGcloud,
): Promise<GcloudResult<string>> {
  try {
    const { stdout } = await run([
      "secrets",
      "versions",
      "access",
      version,
      "--secret",
      secret,
      "--project",
      project,
    ]);
    return { ok: true, value: stdout };
  } catch (err) {
    return classifyGcloudFailure(err);
  }
}

/** What the pull records for one secret. */
export type SecretFetch =
  | { ok: true; active: ActiveVersion | null; value: string | null }
  | { ok: false; message: string };

/**
 * Reads a secret's newest enabled version and its value. A NOT_FOUND at either
 * step yields a null there, which the pull records as missing. Any other
 * failure yields `ok: false`, and the pull reports it and leaves the secret's
 * row in secrets.db untouched.
 */
export async function fetchSecret(
  secret: string,
  project: string,
  run: GcloudRunner = runGcloud,
): Promise<SecretFetch> {
  const active = await activeVersion(secret, project, run);
  if (!active.ok) {
    if (active.reason === "error") {
      return { ok: false, message: `versions list: ${active.message}` };
    }
    return { ok: true, active: null, value: null };
  }
  const value = await accessValue(secret, active.value.version, project, run);
  if (!value.ok) {
    if (value.reason === "error") {
      return { ok: false, message: `versions access: ${value.message}` };
    }
    return { ok: true, active: active.value, value: null };
  }
  return { ok: true, active: active.value, value: value.value };
}
