/**
 * The enrollment contract for brokered credentials (ADR-143): take the model
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
import { BROKERABLE_HARNESS_PROVIDER, type BrokerableHarness } from "../wire";
import type { CredentialKind, HeldCredential } from "./credential-store";
import { claudeManagedSettingsPath } from "./model-base-url";
import {
  looksLikeRunToken,
  peekRunTokenClaims,
  readRunTokenKey,
  type RunTokenProvider,
  verifyRunToken,
} from "./run-token";

export type ModelCredentialHarness = BrokerableHarness;

/** The provider each harness's credential is for, read off the route table. */
export const HARNESS_PROVIDER: Record<
  ModelCredentialHarness,
  RunTokenProvider
> = BROKERABLE_HARNESS_PROVIDER;

export interface ModelCredentialOptions {
  /** The user's home directory; `~/.claude` and `~/.codex` are read under it. */
  home: string;
  harnesses: ModelCredentialHarness[];
  /**
   * The command line Claude Code's `apiKeyHelper` runs. Ends in
   * `credential issue --harness claude-code`; `isTachoHelper` recognises it
   * whatever binary it names. Required when `claude-code` is among the
   * harnesses applied; a Codex-only apply (the daemon renewing a static
   * token) needs none.
   */
  helperCommand?: string;
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
   * file that does not exist and nothing to write into it, or a Claude Code
   * `env` block that sets both a key and a bearer (`two_credentials`), which
   * custody holds one of per provider and so refuses to take either.
   */
  reason?:
    | "subscription_login"
    | "symlink"
    | "no_file"
    | "no_token"
    | "foreign_key_present"
    | "two_credentials";
  /**
   * Restore only: whether the released secret the caller supplied was written
   * back into the file. False when the caller supplied none, and when the
   * file already held a key of the person's own (`foreign_key_present`), in
   * which case the caller keeps or discards custody knowingly rather than
   * releasing a secret that went nowhere.
   */
  secretRestored?: boolean;
  /** Claude Code only: what `apiKeyHelper` holds now. */
  helper?: string | null;
  /**
   * Codex only: when the static run token in `auth.json` expires, read off
   * the token's own claims. A brokered Codex whose token is near this date
   * is one the daemon renews; one past it is refused until it does.
   */
  tokenExpiresAt?: string;
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

function isSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Whether Claude Code's `env` block sets both a key and a bearer. Custody
 * holds one credential per provider, so taking both would keep the second
 * and lose the first: apply takes neither and says so, and the person picks
 * which one the gateway should hold.
 */
function holdsBothClaudeMembers(env: JsonObject): boolean {
  return isSecret(env[CLAUDE_API_KEY]) && isSecret(env[CLAUDE_AUTH_TOKEN]);
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
  let tokenExpiresAt: string | undefined;
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
    if (!brokered && holdsBothClaudeMembers(env)) why ??= "two_credentials";
    shadow = managedHelperShadow(
      internals.managedSettingsFile ?? claudeManagedSettingsPath(),
      options.helperCommand ?? "",
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
    if (brokered) {
      const claims = peekRunTokenClaims(key as string);
      if (claims !== undefined)
        tokenExpiresAt = new Date(claims.exp).toISOString();
    }
    if (!brokered && why === undefined && auth["tokens"] !== undefined)
      why = "subscription_login";
  }
  return {
    harness,
    file,
    brokered,
    ...(why !== undefined && !brokered ? { reason: why } : {}),
    ...(helper !== undefined ? { helper } : {}),
    ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
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
  // Both members set: nothing is taken and the file is left as it is. The
  // store keys custody by provider, so the second take would replace the
  // first and unenroll could give back only one of the two.
  if (env !== undefined && holdsBothClaudeMembers(env))
    return { changed: false, reason: "two_credentials" };
  const rest: JsonObject = { ...(env ?? {}) };
  const took: Sidecar["taken"] = [];
  for (const [member, kind] of [
    [CLAUDE_API_KEY, "api_key"],
    [CLAUDE_AUTH_TOKEN, "bearer"],
  ] as const) {
    const value = rest[member];
    if (isSecret(value)) {
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
  const helperCommand = options.helperCommand;
  if (helperCommand === undefined)
    throw new Error(
      "applying Claude Code's credential needs the helper command line",
    );
  const current = settings[HELPER_KEY];
  const helperOk = current === helperCommand;
  if (helperOk && took.length === 0 && existing !== undefined)
    return { changed: false };
  const previousHelper =
    typeof current === "string" && !isTachoHelper(current) ? current : null;
  settings[HELPER_KEY] = helperCommand;
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
  if (
    auth["tokens"] !== undefined &&
    !looksLikeRunToken(typeof current === "string" ? current : undefined)
  ) {
    // A ChatGPT login, with or without a key beside it: Codex prefers the
    // login, so a token written here would not be what it sends, and the
    // chatgpt.com upstream takes no API key anyway. Left as it is.
    return { changed: false, reason: "subscription_login" };
  }
  if (hasKey && !looksLikeRunToken(current as string)) {
    taken.push({
      harness: "codex",
      provider: "openai",
      credential: { kind: "bearer", secret: current as string },
      member: CODEX_KEY,
    });
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

interface RestoreOutcome {
  changed: boolean;
  secretRestored: boolean;
  reason?: ModelCredentialHarnessState["reason"];
}

function restoreClaude(
  options: ModelCredentialOptions,
  released: HeldCredential | undefined,
): RestoreOutcome {
  const file = fileFor("claude-code", options.home);
  const backup = sidecarFor(file);
  const sidecar = readSidecar(backup);
  const text = readTextIfExists(file);
  const dropSidecar = (): void => {
    if (existsSync(backup)) unlinkSync(backup);
  };
  if (text === undefined) {
    // The file is gone. A released key still has to land somewhere the
    // harness reads, so it goes into a fresh settings file rather than back
    // into a store that is about to be shredded.
    if (released !== undefined) {
      const member =
        released.kind === "bearer" ? CLAUDE_AUTH_TOKEN : CLAUDE_API_KEY;
      writeAtomicPreserving(
        file,
        serializeLike(undefined, { env: { [member]: released.secret } }),
      );
      dropSidecar();
      return { changed: true, secretRestored: true };
    }
    dropSidecar();
    return { changed: false, secretRestored: false };
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
  let secretRestored = false;
  if (released !== undefined) {
    const member =
      sidecar?.taken.find((t) => t.kind === released.kind)?.member ??
      (released.kind === "bearer" ? CLAUDE_AUTH_TOKEN : CLAUDE_API_KEY);
    const env = { ...(envOf(settings) ?? {}) };
    env[member] = released.secret;
    settings["env"] = env;
    touched = true;
    secretRestored = true;
  } else if (sidecar?.created_env === true) {
    const env = envOf(settings);
    if (env !== undefined && Object.keys(env).length === 0) {
      delete settings["env"];
      touched = true;
    }
  }
  if (!touched) {
    dropSidecar();
    return { changed: false, secretRestored };
  }
  const next = serializeLike(text, settings);
  if (next === text) {
    dropSidecar();
    return { changed: false, secretRestored };
  }
  writeAtomicPreserving(file, next);
  dropSidecar();
  return { changed: true, secretRestored };
}

function restoreCodex(
  options: ModelCredentialOptions,
  released: HeldCredential | undefined,
): RestoreOutcome {
  const file = fileFor("codex", options.home);
  const backup = sidecarFor(file);
  const sidecar = readSidecar(backup);
  const text = readTextIfExists(file);
  const dropSidecar = (): void => {
    if (existsSync(backup)) unlinkSync(backup);
  };
  if (text === undefined) {
    if (released !== undefined) {
      writeAtomicPreserving(
        file,
        serializeLike(undefined, { [CODEX_KEY]: released.secret }),
      );
      dropSidecar();
      return { changed: true, secretRestored: true };
    }
    dropSidecar();
    return { changed: false, secretRestored: false };
  }
  const auth = parseObject(text, file);
  const current = auth[CODEX_KEY];
  if (!looksLikeRunToken(typeof current === "string" ? current : undefined)) {
    // Somebody already put a key of their own back, or logged in again. Their
    // value wins; the caller is told the released key went nowhere.
    dropSidecar();
    return {
      changed: false,
      secretRestored: false,
      ...(typeof current === "string" && current.length > 0
        ? { reason: "foreign_key_present" as const }
        : {}),
    };
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
    return { changed: true, secretRestored: released !== undefined };
  }
  const next = serializeLike(text, auth);
  writeAtomicPreserving(file, next);
  dropSidecar();
  return { changed: true, secretRestored: released !== undefined };
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
    const outcome =
      harness === "claude-code"
        ? restoreClaude(options, released)
        : restoreCodex(options, released);
    return {
      ...describe(harness, options, outcome.changed, internals, outcome.reason),
      secretRestored: outcome.secretRestored,
    };
  });
  return { harnesses, taken: [] };
}

/**
 * The secrets apply would take, without writing anything. The caller seals
 * them first and applies second, so a crash between the two leaves the key
 * where it was rather than nowhere.
 */
export async function peekModelCredentials(
  options: ModelCredentialOptions,
): Promise<TakenCredential[]> {
  const taken: TakenCredential[] = [];
  for (const harness of unique(options.harnesses)) {
    const file = fileFor(harness, options.home);
    const text = readTextIfExists(file);
    if (text === undefined) continue;
    const document = parseObject(text, file);
    if (harness === "claude-code") {
      const env = envOf(document) ?? {};
      // The same refusal apply makes, so nothing is sealed that apply will
      // then leave in the file.
      if (holdsBothClaudeMembers(env)) continue;
      for (const [member, kind] of [
        [CLAUDE_API_KEY, "api_key"],
        [CLAUDE_AUTH_TOKEN, "bearer"],
      ] as const) {
        const value = env[member];
        if (isSecret(value))
          taken.push({
            harness,
            provider: "anthropic",
            credential: { kind, secret: value },
            member: `env.${member}`,
          });
      }
    } else {
      const current = document[CODEX_KEY];
      if (
        document["tokens"] === undefined &&
        typeof current === "string" &&
        current.length > 0 &&
        !looksLikeRunToken(current)
      )
        taken.push({
          harness,
          provider: "openai",
          credential: { kind: "bearer", secret: current },
          member: CODEX_KEY,
        });
    }
  }
  return taken;
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

/** A static token this close to its expiry is re-minted rather than kept. */
export const STATIC_TOKEN_RENEW_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * How close to its expiry a static token is re-minted: the renewal window,
 * or half of what is left of the enrollment when that is shorter. A static
 * token is clamped to the enrollment's expiry, so inside the last week of an
 * enrollment a fixed window would call every token due, re-mint it hourly,
 * and get back one with the same expiry each time.
 */
export function staticTokenRenewWindowMs(
  host: { expires_at?: string },
  now: number,
): number {
  const notAfter = Date.parse(host.expires_at ?? "");
  if (!Number.isFinite(notAfter)) return STATIC_TOKEN_RENEW_WINDOW_MS;
  return Math.min(STATIC_TOKEN_RENEW_WINDOW_MS, (notAfter - now) / 2);
}

/**
 * Whether the run token a Codex file holds is one this host's gateway will
 * still honour for a while: signed by the key on disk, bound to this
 * enrollment, and not inside the renewal window. Anything else is re-minted.
 */
export function staticTokenStillGood(
  token: string | undefined,
  host: { host_enrollment_id: string; expires_at?: string },
  keyPath: string,
  now: number,
): boolean {
  if (token === undefined || !looksLikeRunToken(token)) return false;
  const key = readRunTokenKey(keyPath);
  if (key === undefined) return false;
  const verdict = verifyRunToken(token, {
    key,
    host: host.host_enrollment_id,
    provider: "openai",
    now,
  });
  return (
    verdict.ok && verdict.claims.exp - now > staticTokenRenewWindowMs(host, now)
  );
}

/**
 * The `OPENAI_API_KEY` member of `~/.codex/auth.json` under `home`, whatever
 * it holds: a vendor key, a static run token, or nothing. The one reader the
 * CLI and the daemon share, on the same file apply edits.
 */
export function readCodexApiKeyMember(home: string): string | undefined {
  const file = fileFor("codex", home);
  try {
    const text = readTextIfExists(file);
    if (text === undefined) return undefined;
    const value = parseObject(text, file)[CODEX_KEY];
    return typeof value === "string" ? value : undefined;
  } catch {
    // Unreadable or not JSON reads as "no token", which re-mints: the same
    // answer a missing file gives.
    return undefined;
  }
}
