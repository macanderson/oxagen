/**
 * The enrollment contract for brokered credentials (ADR-138): take the model
 * vendor's key out of the harness's own files and put a run token in its
 * place, so the only credential the harness holds is one that works at the
 * gateway and nowhere else.
 *
 * Two harnesses, each through the one setting its vendor documents for it:
 *
 *   - Claude Code runs `apiKeyHelper` (a command line in `settings.json`)
 *     and sends what it prints as `X-Api-Key`, re-running it every five
 *     minutes and on any 401. Enrollment sets the helper to `tacho credential
 *     issue --harness claude-code`, which prints a fresh fifteen-minute run
 *     token. A key in `env.ANTHROPIC_API_KEY` or a bearer in
 *     `env.ANTHROPIC_AUTH_TOKEN` would win over the helper, so both are taken
 *     out of the file and handed to the caller for custody. A subscription
 *     login is left alone: the helper wins over it, so a brokered host sends
 *     the run token whichever way the person signed in.
 *   - Codex reads `OPENAI_API_KEY` from `auth.json` and sends it as
 *     `Authorization: Bearer`. It has no helper, so enrollment writes a
 *     static run token into that member and hands the displaced key to the
 *     caller. A ChatGPT login (`tokens` present, no key) cannot be brokered:
 *     the file is left as it is and the state says so.
 *
 * The secret never touches a sidecar. What apply displaces goes back to the
 * caller (`taken`), who seals it in the custody store; the sidecar beside the
 * file records only which members were taken and what the file looked like,
 * so restore can put the secret back exactly where it was without ever having
 * held it. The rest of the contract is the model base URL writer's: idempotent
 * apply, byte-exact restore when nobody else edited the file, a surgical edit
 * when somebody did, and the receipt written before the file.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CredentialKind, HeldCredential } from "./credential-store";
import { claudeManagedSettingsPath } from "./model-base-url";
import { looksLikeRunToken, type RunTokenProvider } from "./run-token";

export type ModelCredentialHarness = "claude-code" | "codex";

/** The provider each harness's credential is for. */
export const HARNESS_PROVIDER: Record<
  ModelCredentialHarness,
  RunTokenProvider
> = {
  "claude-code": "anthropic",
  codex: "openai",
};

export interface ModelCredentialOptions {
  /** The user's home directory; `~/.claude` and `~/.codex` are read under it. */
  home: string;
  harnesses: ModelCredentialHarness[];
  /**
   * The command line Claude Code's `apiKeyHelper` runs. Ends in
   * `credential issue --harness claude-code`; `isTachoHelper` recognises it
   * whatever binary it names.
   */
  helperCommand: string;
  /** Codex only: the static run token to write into `auth.json`. */
  staticTokens?: Partial<Record<ModelCredentialHarness, string>>;
}

/** A secret apply took out of a harness file, for the caller to seal. */
export interface TakenCredential {
  harness: ModelCredentialHarness;
  provider: RunTokenProvider;
  credential: HeldCredential;
  /** The member it came out of, as a person would name it. */
  member: string;
}

export interface ModelCredentialHarnessState {
  harness: ModelCredentialHarness;
  file: string;
  /** Whether the file now hands the harness a run token and nothing else. */
  brokered: boolean;
  /**
   * Why the harness is not brokered when it is not: a ChatGPT login Codex
   * keeps in `auth.json`, a file that is a symlink apply will not rewrite, a
   * file that does not exist and nothing to write into it.
   */
  reason?: "subscription_login" | "symlink" | "no_file" | "no_token";
  /** Claude Code only: what `apiKeyHelper` holds now. */
  helper?: string | null;
  /**
   * A managed settings file that sets `apiKeyHelper` to something else.
   * Managed settings win, so the harness does not run ours.
   */
  shadowedBy?: { file: string; value: string };
  /** Whether this call changed the file. */
  changed: boolean;
  /** The sidecar that remembers what apply displaced. */
  backup: string;
}

export interface ModelCredentialState {
  harnesses: ModelCredentialHarnessState[];
  /** Secrets apply took out of the files. Empty on restore and read. */
  taken: TakenCredential[];
}

const SIDECAR_SCHEMA = "oxagen.model-credential.v1";
const HELPER_KEY = "apiKeyHelper";
const CLAUDE_API_KEY = "ANTHROPIC_API_KEY";
const CLAUDE_AUTH_TOKEN = "ANTHROPIC_AUTH_TOKEN";
const CODEX_KEY = "OPENAI_API_KEY";
const HELPER_MARK = /\bcredential issue --harness claude-code\s*$/;

/** Whether a helper command line is one enrollment wrote, whatever binary it names. */
export function isTachoHelper(value: unknown): value is string {
  return typeof value === "string" && HELPER_MARK.test(value);
}

/** The helper command line for a `tacho` binary's command prefix. */
export function helperCommandFor(tachoCommand: string): string {
  return `${tachoCommand} credential issue --harness claude-code`;
}

function fileFor(harness: ModelCredentialHarness, home: string): string {
  return harness === "claude-code"
    ? join(home, ".claude", "settings.json")
    : join(home, ".codex", "auth.json");
}

function sidecarFor(file: string): string {
  return join(dirname(file), `.${basename(file)}.oxagen-model-credential.json`);
}

/** The receipt survives a reassign that drops this harness from host.json. */
export function modelCredentialBackupPath(
  harness: ModelCredentialHarness,
  home: string,
): string {
  return sidecarFor(fileFor(harness, home));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Sidecar {
  schema: typeof SIDECAR_SCHEMA;
  harness: ModelCredentialHarness;
  existed: boolean;
  /** The digest of the file as the latest apply left it. */
  written_sha256: string;
  /** Claude Code: the helper apply displaced, or null when there was none. */
  previous_helper: string | null;
  /** Claude Code: whether apply had to create the `env` object. */
  created_env: boolean;
  /**
   * The members apply took a secret out of, with the kind each was, so
   * restore knows where a released secret goes. Never the secret.
   */
  taken: Array<{ member: string; kind: CredentialKind }>;
  /** Codex: whether `OPENAI_API_KEY` existed before apply. */
  had_key: boolean;
}

function readSidecar(path: string): Sidecar | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Sidecar>;
    if (parsed.schema !== SIDECAR_SCHEMA) return undefined;
    if (typeof parsed.written_sha256 !== "string") return undefined;
    return {
      schema: SIDECAR_SCHEMA,
      harness: parsed.harness === "codex" ? "codex" : "claude-code",
      existed: parsed.existed === true,
      written_sha256: parsed.written_sha256,
      previous_helper:
        typeof parsed.previous_helper === "string"
          ? parsed.previous_helper
          : null,
      created_env: parsed.created_env === true,
      taken: Array.isArray(parsed.taken)
        ? parsed.taken.filter(
            (t): t is { member: string; kind: CredentialKind } =>
              typeof t === "object" &&
              t !== null &&
              typeof (t as { member?: unknown }).member === "string" &&
              ((t as { kind?: unknown }).kind === "api_key" ||
                (t as { kind?: unknown }).kind === "bearer"),
          )
        : [],
      had_key: parsed.had_key === true,
    };
  } catch {
    return undefined;
  }
}

function writeAtomicPreserving(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  let owner: { uid: number; gid: number } | undefined;
  try {
    const stat = statSync(path);
    mode = stat.mode & 0o7777;
    owner = { uid: stat.uid, gid: stat.gid };
  } catch {
    // A new file has no mode or owner to keep.
  }
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
    if (owner !== undefined) {
      try {
        chownSync(tmp, owner.uid, owner.gid);
      } catch {
        // Only root may give a file away.
      }
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

type JsonObject = Record<string, unknown>;

function parseObject(text: string | undefined, file: string): JsonObject {
  if (text === undefined || text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON, so it was left untouched: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} is not a JSON object, so it was left untouched`);
  return parsed as JsonObject;
}

function envOf(settings: JsonObject): JsonObject | undefined {
  const env = settings["env"];
  return typeof env === "object" && env !== null && !Array.isArray(env)
    ? (env as JsonObject)
    : undefined;
}

/** Serialize the way the file was written: its indent and its final newline. */
function serializeLike(text: string | undefined, value: JsonObject): string {
  const indent = /\n([ \t]+)"/.exec(text ?? "")?.[1] ?? "  ";
  const eol = text !== undefined && text.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(value, null, indent).replace(/\n/g, eol);
  const final = text === undefined || /\r?\n$/.test(text) ? eol : "";
  return `${body}${final}`;
}

function managedHelperShadow(
  managedFile: string,
  expected: string,
): { file: string; value: string } | undefined {
  try {
    const text = readTextIfExists(managedFile);
    if (text === undefined) return undefined;
    const value = parseObject(text, managedFile)[HELPER_KEY];
    return typeof value === "string" && value !== expected
      ? { file: managedFile, value }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ModelCredentialInternals {
  /** Overrides the managed settings path; tests point it at a scratch file. */
  managedSettingsFile?: string;
  /** Overrides the symlink probe; tests never need it. */
  lstat?: (path: string) => { isSymbolicLink: () => boolean } | undefined;
}

function linked(path: string, internals: ModelCredentialInternals): boolean {
  if (internals.lstat !== undefined)
    return internals.lstat(path)?.isSymbolicLink() === true;
  return isSymlink(path);
}

function describe(
  harness: ModelCredentialHarness,
  options: ModelCredentialOptions,
  changed: boolean,
  internals: ModelCredentialInternals,
  reason?: ModelCredentialHarnessState["reason"],
): ModelCredentialHarnessState {
  const file = fileFor(harness, options.home);
  const backup = sidecarFor(file);
  const text = readTextIfExists(file);
  let brokered = false;
  let helper: string | null | undefined;
  let shadow: { file: string; value: string } | undefined;
  let why = reason;
  if (text === undefined) {
    why ??= "no_file";
  } else if (harness === "claude-code") {
    let settings: JsonObject = {};
    try {
      settings = parseObject(text, file);
    } catch {
      settings = {};
    }
    const current = settings[HELPER_KEY];
    helper = typeof current === "string" ? current : null;
    const env = envOf(settings) ?? {};
    // Brokered means the helper is ours AND nothing in the env block would
    // win over it: Claude Code reads a key or a bearer from `env` first.
    brokered =
      isTachoHelper(current) &&
      typeof env[CLAUDE_API_KEY] !== "string" &&
      typeof env[CLAUDE_AUTH_TOKEN] !== "string";
    shadow = managedHelperShadow(
      internals.managedSettingsFile ?? claudeManagedSettingsPath(),
      options.helperCommand,
    );
  } else {
    let auth: JsonObject = {};
    try {
      auth = parseObject(text, file);
    } catch {
      auth = {};
    }
    const key = auth[CODEX_KEY];
    brokered = looksLikeRunToken(typeof key === "string" ? key : undefined);
    if (!brokered && why === undefined && auth["tokens"] !== undefined)
      why = "subscription_login";
  }
  return {
    harness,
    file,
    brokered,
    ...(why !== undefined && !brokered ? { reason: why } : {}),
    ...(helper !== undefined ? { helper } : {}),
    ...(shadow !== undefined ? { shadowedBy: shadow } : {}),
    changed,
    backup,
  };
}

function writeSidecar(backup: string, sidecar: Sidecar): void {
  writeAtomicPreserving(backup, `${JSON.stringify(sidecar, null, 2)}\n`);
  chmodSync(backup, 0o600);
}

function applyClaude(
  options: ModelCredentialOptions,
  taken: TakenCredential[],
): { changed: boolean; reason?: ModelCredentialHarnessState["reason"] } {
  const file = fileFor("claude-code", options.home);
  const backup = sidecarFor(file);
  const text = readTextIfExists(file);
  const settings = parseObject(text, file);
  const existing = readSidecar(backup);
  const env = envOf(settings);
  const rest: JsonObject = { ...(env ?? {}) };
  const took: Sidecar["taken"] = [];
  for (const [member, kind] of [
    [CLAUDE_API_KEY, "api_key"],
    [CLAUDE_AUTH_TOKEN, "bearer"],
  ] as const) {
    const value = rest[member];
    if (typeof value === "string" && value.length > 0) {
      taken.push({
        harness: "claude-code",
        provider: "anthropic",
        credential: { kind, secret: value },
        member: `env.${member}`,
      });
      took.push({ member, kind });
      delete rest[member];
    }
  }
  const current = settings[HELPER_KEY];
  const helperOk = current === options.helperCommand;
  if (helperOk && took.length === 0 && existing !== undefined)
    return { changed: false };
  const previousHelper =
    typeof current === "string" && !isTachoHelper(current) ? current : null;
  settings[HELPER_KEY] = options.helperCommand;
  if (env !== undefined || Object.keys(rest).length > 0) settings["env"] = rest;
  const next = serializeLike(text, settings);
  const sidecar: Sidecar = existing
    ? {
        ...existing,
        written_sha256: sha256(next),
        // A member taken on a later apply (the person put a key back) is
        // remembered too, so restore returns it.
        taken: [
          ...existing.taken,
          ...took.filter(
            (t) => !existing.taken.some((e) => e.member === t.member),
          ),
        ],
      }
    : {
        schema: SIDECAR_SCHEMA,
        harness: "claude-code",
        existed: text !== undefined,
        written_sha256: sha256(next),
        previous_helper: previousHelper,
        created_env: env === undefined,
        taken: took,
        had_key: false,
      };
  // The receipt lands first: a crash between the two writes leaves a backup
  // with nothing to restore, never a displaced member with no record of it.
  writeSidecar(backup, sidecar);
  writeAtomicPreserving(file, next);
  return { changed: true };
}

function applyCodex(
  options: ModelCredentialOptions,
  taken: TakenCredential[],
): { changed: boolean; reason?: ModelCredentialHarnessState["reason"] } {
  const file = fileFor("codex", options.home);
  const backup = sidecarFor(file);
  const token = options.staticTokens?.codex;
  const text = readTextIfExists(file);
  const auth = parseObject(text, file);
  const existing = readSidecar(backup);
  const current = auth[CODEX_KEY];
  const hasKey = typeof current === "string" && current.length > 0;
  if (hasKey && !looksLikeRunToken(current as string)) {
    taken.push({
      harness: "codex",
      provider: "openai",
      credential: { kind: "bearer", secret: current as string },
      member: CODEX_KEY,
    });
  } else if (!hasKey && auth["tokens"] !== undefined) {
    // A ChatGPT login: nothing to take into custody, and a token written
    // here would not be what Codex sends. Left as it is.
    return { changed: false, reason: "subscription_login" };
  }
  if (token === undefined) {
    // Nothing to write: the caller took the key (above) but issued no token.
    // Refuse to leave a file with a key that is about to move into custody.
    if (taken.some((t) => t.harness === "codex")) taken.pop();
    return { changed: false, reason: "no_token" };
  }
  if (current === token && existing !== undefined) return { changed: false };
  auth[CODEX_KEY] = token;
  const next = serializeLike(text, auth);
  const sidecar: Sidecar = existing
    ? { ...existing, written_sha256: sha256(next) }
    : {
        schema: SIDECAR_SCHEMA,
        harness: "codex",
        existed: text !== undefined,
        written_sha256: sha256(next),
        previous_helper: null,
        created_env: false,
        taken: hasKey ? [{ member: CODEX_KEY, kind: "bearer" }] : [],
        had_key: hasKey,
      };
  writeSidecar(backup, sidecar);
  writeAtomicPreserving(file, next);
  return { changed: true };
}

export interface RestoreSecrets {
  /** The secrets released from custody, by provider, to put back. */
  secrets?: Partial<Record<RunTokenProvider, HeldCredential>>;
}

function restoreClaude(
  options: ModelCredentialOptions,
  released: HeldCredential | undefined,
): boolean {
  const file = fileFor("claude-code", options.home);
  const backup = sidecarFor(file);
  const sidecar = readSidecar(backup);
  const text = readTextIfExists(file);
  const dropSidecar = (): void => {
    if (existsSync(backup)) unlinkSync(backup);
  };
  if (text === undefined) {
    dropSidecar();
    return false;
  }
  // Edited or not, the secret has to go back by name: a byte-exact restore
  // of the original would put it back too, but the file may hold hook
  // entries and a base URL enrollment still owns, so only our members move.
  const settings = parseObject(text, file);
  let touched = false;
  if (isTachoHelper(settings[HELPER_KEY])) {
    if (sidecar?.previous_helper != null)
      settings[HELPER_KEY] = sidecar.previous_helper;
    else delete settings[HELPER_KEY];
    touched = true;
  }
  // A released secret goes back whether or not the receipt survived: the
  // receipt names the member it came out of, and without one the kind says
  // which member Claude Code reads that kind from. A lost receipt must not
  // lose the key, because the caller releases it from custody once this
  // returns.
  if (released !== undefined) {
    const member =
      sidecar?.taken.find((t) => t.kind === released.kind)?.member ??
      (released.kind === "bearer" ? CLAUDE_AUTH_TOKEN : CLAUDE_API_KEY);
    const env = { ...(envOf(settings) ?? {}) };
    env[member] = released.secret;
    settings["env"] = env;
    touched = true;
  } else if (sidecar?.created_env === true) {
    const env = envOf(settings);
    if (env !== undefined && Object.keys(env).length === 0) {
      delete settings["env"];
      touched = true;
    }
  }
  if (!touched) {
    dropSidecar();
    return false;
  }
  const next = serializeLike(text, settings);
  if (next === text) {
    dropSidecar();
    return false;
  }
  writeAtomicPreserving(file, next);
  dropSidecar();
  return true;
}

function restoreCodex(
  options: ModelCredentialOptions,
  released: HeldCredential | undefined,
): boolean {
  const file = fileFor("codex", options.home);
  const backup = sidecarFor(file);
  const sidecar = readSidecar(backup);
  const text = readTextIfExists(file);
  const dropSidecar = (): void => {
    if (existsSync(backup)) unlinkSync(backup);
  };
  if (text === undefined) {
    dropSidecar();
    return false;
  }
  const auth = parseObject(text, file);
  const current = auth[CODEX_KEY];
  if (!looksLikeRunToken(typeof current === "string" ? current : undefined)) {
    // Somebody already put their own value back, or logged in again.
    dropSidecar();
    return false;
  }
  if (released !== undefined) auth[CODEX_KEY] = released.secret;
  else delete auth[CODEX_KEY];
  if (
    sidecar !== undefined &&
    !sidecar.existed &&
    Object.keys(auth).length === 0
  ) {
    unlinkSync(file);
    dropSidecar();
    return true;
  }
  const next = serializeLike(text, auth);
  writeAtomicPreserving(file, next);
  dropSidecar();
  return true;
}

function unique(
  harnesses: readonly ModelCredentialHarness[],
): ModelCredentialHarness[] {
  return [...new Set(harnesses)];
}

/**
 * Take each harness's vendor credential out of its file and point the harness
 * at the gateway's run tokens instead. Idempotent; a second call changes
 * nothing and takes nothing. The secrets taken are returned once, here, and
 * the caller seals them.
 */
export async function applyModelCredentials(
  options: ModelCredentialOptions,
  internals: ModelCredentialInternals = {},
): Promise<ModelCredentialState> {
  const taken: TakenCredential[] = [];
  const harnesses = unique(options.harnesses).map((harness) => {
    const file = fileFor(harness, options.home);
    if (linked(file, internals))
      return describe(harness, options, false, internals, "symlink");
    const outcome =
      harness === "claude-code"
        ? applyClaude(options, taken)
        : applyCodex(options, taken);
    return describe(
      harness,
      options,
      outcome.changed,
      internals,
      outcome.reason,
    );
  });
  return { harnesses, taken };
}

/**
 * Put back what apply displaced: the helper Claude Code had, the key each
 * file held (supplied by the caller from custody), and remove only what
 * apply added.
 */
export async function restoreModelCredentials(
  options: ModelCredentialOptions,
  restore: RestoreSecrets = {},
  internals: ModelCredentialInternals = {},
): Promise<ModelCredentialState> {
  const harnesses = unique(options.harnesses).map((harness) => {
    const released = restore.secrets?.[HARNESS_PROVIDER[harness]];
    const changed =
      harness === "claude-code"
        ? restoreClaude(options, released)
        : restoreCodex(options, released);
    return describe(harness, options, changed, internals);
  });
  return { harnesses, taken: [] };
}

/** What each harness file holds now. Reads only. */
export async function readModelCredentialState(
  options: ModelCredentialOptions,
  internals: ModelCredentialInternals = {},
): Promise<ModelCredentialState> {
  return {
    harnesses: unique(options.harnesses).map((harness) =>
      describe(harness, options, false, internals),
    ),
    taken: [],
  };
}

/** A dropped harness with no receipt can still hold a run token or our helper. */
export function hasOrphanedModelCredential(
  harness: ModelCredentialHarness,
  home: string,
): boolean {
  const file = fileFor(harness, home);
  const text = readTextIfExists(file);
  if (text === undefined) return false;
  try {
    const document = parseObject(text, file);
    if (harness === "claude-code") return isTachoHelper(document[HELPER_KEY]);
    const key = document[CODEX_KEY];
    return looksLikeRunToken(typeof key === "string" ? key : undefined);
  } catch {
    return (
      text.includes("credential issue --harness") || text.includes("oxrt_")
    );
  }
}
