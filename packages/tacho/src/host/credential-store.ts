/**
 * The gateway's custody of a model vendor's credential (ADR-138).
 *
 * On the brokered credential path the harness holds a run token and the
 * daemon holds the vendor key, so the key needs a home on the machine that
 * is not a harness config file. This is it: `credentials.json` under
 * `TACHO_HOME`, each secret sealed with AES-256-GCM under a key that lives in
 * its own file beside it, both mode 0600.
 *
 * The two files are separate on purpose. A copy of `credentials.json` on its
 * own decrypts nothing, `unenroll` shreds custody by overwriting the key
 * before it deletes the file, and the key file is the one seam an OS keystore
 * would replace. The store never logs a secret, never returns one from
 * `status`, and records for each provider only where the secret came from and
 * when it was taken, which is what `tacho credential status` shows.
 *
 * The vendor credential still stays on the machine, which is the property
 * ADR-094 fixed. What changes is which process on the machine holds it: the
 * gateway rather than the harness, so the harness cannot spend it anywhere
 * but through the gateway.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { writeSensitiveFileAtomic } from "./fs";
import { type RunTokenProvider, RUN_TOKEN_PROVIDERS } from "./run-token";

export const CREDENTIAL_STORE_SCHEMA = "tacho.credentials.v1" as const;

/**
 * Where a credential in custody came from, as a person would name it. Never
 * a path to a secret that still holds one.
 */
export const CREDENTIAL_SOURCES = [
  /** `env.ANTHROPIC_API_KEY` in Claude Code's user settings. */
  "claude-code:settings.env",
  /** `OPENAI_API_KEY` in Codex's `auth.json`. */
  "codex:auth.json",
  /** `TACHO_BROKER_<PROVIDER>_API_KEY` in the enrolling shell. */
  "enroll:env",
] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/**
 * How the vendor expects the secret: `api_key` rides `X-Api-Key` (Anthropic's
 * keys), `bearer` rides `Authorization: Bearer` (OpenAI's keys, and a token a
 * corporate gateway issued for Anthropic's API).
 */
export const CREDENTIAL_KINDS = ["api_key", "bearer"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** A secret out of custody, with the header it belongs in. */
export interface HeldCredential {
  kind: CredentialKind;
  secret: string;
}

const sealedSchema = z
  .object({
    /** AES-256-GCM: 12-byte nonce, ciphertext, 16-byte tag, all base64. */
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
    tag: z.string().min(1),
  })
  .strict();

const entrySchema = z
  .object({
    provider: z.enum(RUN_TOKEN_PROVIDERS),
    kind: z.enum(CREDENTIAL_KINDS),
    source: z.enum(CREDENTIAL_SOURCES),
    taken_at: z.string(),
    /** sha256 over the secret: lets a status report say "unchanged" without the secret. */
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** The first few characters, the way a vendor console shows a key. */
    prefix: z.string().max(12),
    sealed: sealedSchema,
  })
  .strict();

const fileSchema = z
  .object({
    schema: z.literal(CREDENTIAL_STORE_SCHEMA),
    entries: z.array(entrySchema),
  })
  .strict();

type StoredEntry = z.output<typeof entrySchema>;

/** What the store says about a provider without saying the secret. */
export interface CredentialCustody {
  provider: RunTokenProvider;
  kind: CredentialKind;
  source: CredentialSource;
  taken_at: string;
  digest: string;
  prefix: string;
}

export interface CredentialStore {
  /** The secret for a provider, or undefined when none is in custody. */
  read: (provider: RunTokenProvider) => HeldCredential | undefined;
  /** Take a secret into custody, replacing any earlier one for the provider. */
  take: (
    provider: RunTokenProvider,
    credential: HeldCredential,
    source: CredentialSource,
    now: number,
  ) => CredentialCustody;
  /** Give a provider's secret up. Returns it, for the file it goes back into. */
  release: (provider: RunTokenProvider) => HeldCredential | undefined;
  /** Every provider in custody, secrets omitted. */
  status: () => CredentialCustody[];
  /** Overwrite the key and delete the file: nothing in custody decrypts again. */
  shred: () => void;
}

export interface CredentialStorePaths {
  /** `credentials.json`. */
  file: string;
  /** `credentials.key`: 32 random bytes, hex. */
  key: string;
}

const KEY_BYTES = 32;

function loadOrCreateKey(path: string): Buffer {
  try {
    const hex = readFileSync(path, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(hex))
      throw new Error(`${path} does not hold a 32-byte key`);
    return Buffer.from(hex, "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(KEY_BYTES);
  writeSensitiveFileAtomic(path, `${key.toString("hex")}\n`);
  return key;
}

function seal(key: Buffer, secret: string, aad: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function open(
  key: Buffer,
  sealed: z.output<typeof sealedSchema>,
  aad: string,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function digestOf(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

/** The visible head of a key, the way a vendor console prints one. */
export function credentialPrefix(secret: string): string {
  const head = secret.slice(0, Math.min(8, Math.max(0, secret.length - 4)));
  return head.length > 0 ? `${head}…` : "";
}

function custodyOf(entry: StoredEntry): CredentialCustody {
  return {
    provider: entry.provider,
    kind: entry.kind,
    source: entry.source,
    taken_at: entry.taken_at,
    digest: entry.digest,
    prefix: entry.prefix,
  };
}

/**
 * Open the store at `paths`, creating the key on first use. Reads the file on
 * every call rather than caching: the CLI and the daemon both hold a store
 * over the same files, and the daemon must see a key `tacho enroll` took
 * into custody without a restart.
 */
export function openCredentialStore(
  paths: CredentialStorePaths,
): CredentialStore {
  const keyOf = () => loadOrCreateKey(paths.key);

  function readAll(): StoredEntry[] {
    let text: string;
    try {
      text = readFileSync(paths.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw new Error(
        `${paths.file} is not a credential store this build can read: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
    return parsed.data.entries;
  }

  function writeAll(entries: StoredEntry[]): void {
    if (entries.length === 0) {
      if (existsSync(paths.file)) unlinkSync(paths.file);
      return;
    }
    writeSensitiveFileAtomic(
      paths.file,
      `${JSON.stringify({ schema: CREDENTIAL_STORE_SCHEMA, entries }, null, 2)}\n`,
    );
  }

  return {
    read: (provider) => {
      const entry = readAll().find((e) => e.provider === provider);
      if (entry === undefined) return undefined;
      return {
        kind: entry.kind,
        secret: open(
          keyOf(),
          entry.sealed,
          `${CREDENTIAL_STORE_SCHEMA}:${provider}`,
        ),
      };
    },
    take: (provider, { kind, secret }, source, now) => {
      if (secret.trim().length === 0)
        throw new Error("refusing to take an empty credential into custody");
      const entry: StoredEntry = {
        provider,
        kind,
        source,
        taken_at: new Date(now).toISOString(),
        digest: digestOf(secret),
        prefix: credentialPrefix(secret),
        sealed: seal(keyOf(), secret, `${CREDENTIAL_STORE_SCHEMA}:${provider}`),
      };
      writeAll([...readAll().filter((e) => e.provider !== provider), entry]);
      return custodyOf(entry);
    },
    release: (provider) => {
      const entries = readAll();
      const entry = entries.find((e) => e.provider === provider);
      if (entry === undefined) return undefined;
      const secret = open(
        keyOf(),
        entry.sealed,
        `${CREDENTIAL_STORE_SCHEMA}:${provider}`,
      );
      writeAll(entries.filter((e) => e.provider !== provider));
      return { kind: entry.kind, secret };
    },
    status: () => readAll().map(custodyOf),
    shred: () => {
      // The key first: a crash between the two leaves ciphertext nobody can
      // open, never a readable secret with no key to guard it.
      if (existsSync(paths.key))
        writeSensitiveFileAtomic(
          paths.key,
          randomBytes(KEY_BYTES).toString("hex"),
        );
      for (const path of [paths.file, paths.key])
        if (existsSync(path)) unlinkSync(path);
    },
  };
}
