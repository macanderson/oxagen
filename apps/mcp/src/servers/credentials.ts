// credentials.ts: the CredentialSource the served tools call through (lane
// M15; mcp-studio-spec, Credentials).
//
// An environment names its credential as oxagen:credential/<name>. This
// source reads the workspace's mcp.credentials row with that name and
// decrypts it the way the plugin credential service does. Lane M8 replaces
// it with the vault's CredentialSource, which also refreshes OAuth tokens
// and holds operator tokens. Until then an operator-oauth server, a mutual
// TLS server, and a credential that needs reconnecting resolve to missing,
// and the agent reads what to do.
//
// Nothing here logs or returns a decrypted value in a message.
import type { CredentialRequest, CredentialSource, ResolvedCredential } from "@oxagen/mcp-studio";

const REFERENCE = /^oxagen:credential\/(.+)$/;

/** One mcp.credentials row, as the source reads it. */
export interface CredentialRow {
  status: string;
  tokenKmsKeyId: string | null;
  accessTokenEnc: Buffer | null;
  refreshTokenEnc: Buffer | null;
  secretEnc: Buffer | null;
  oauthClientSecretEnc: Buffer | null;
}

/** The secrets of one row, decrypted. */
export interface CredentialSecrets {
  accessToken: string | null;
  secret: string | null;
}

/** Where the source reads and decrypts. Production binds Postgres and the credential key. */
export interface CredentialStore {
  /** The workspace's credential with this name, or null. */
  read(name: string): Promise<CredentialRow | null>;
  /**
   * The row's secrets. Null when this deployment holds no key to decrypt
   * with. Rejects when decryption fails.
   */
  decrypt(row: CredentialRow): Promise<CredentialSecrets | null>;
}

/** The error a source rejects with when it cannot decrypt. Its message names no secret. */
export class ServedCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServedCredentialError";
  }
}

/** The page where a person connects or reconnects a credential. */
export function connectUrl(): string {
  return process.env.APP_URL ?? "https://app.oxagen.sh";
}

function missing(message: string): ResolvedCredential {
  return { type: "missing", message, connect_url: connectUrl() };
}

function apply(request: CredentialRequest, name: string, secrets: CredentialSecrets): ResolvedCredential {
  const { apply: scheme } = request.auth;
  switch (scheme.type) {
    case "oauth2":
    case "openIdConnect":
    case "http_bearer": {
      const token = secrets.accessToken ?? secrets.secret;
      return token === null
        ? missing(`The credential ${name} holds no token. Connect it again in Oxagen, then retry.`)
        : { type: "bearer", token };
    }
    case "api_key":
      return secrets.secret === null
        ? missing(`The credential ${name} holds no key. Connect it again in Oxagen, then retry.`)
        : { type: "api_key", value: secrets.secret };
    case "http_basic": {
      const value = secrets.secret;
      const cut = value === null ? -1 : value.indexOf(":");
      if (value === null || cut < 0) {
        return missing(
          `The credential ${name} is not a user name and a password. Store it as user:password in Oxagen, then retry.`,
        );
      }
      return { type: "basic", username: value.slice(0, cut), password: value.slice(cut + 1) };
    }
    case "mutual_tls":
      return missing(
        `Oxagen cannot send a client certificate for ${request.server} yet. Ask a workspace admin to give the server a token or key credential.`,
      );
  }
}

/**
 * The CredentialSource over one workspace's mcp.credentials. It rejects
 * only when decryption fails, and the error names no secret.
 */
export function workspaceCredentialSource(store: CredentialStore): CredentialSource {
  return {
    async resolve(request: CredentialRequest): Promise<ResolvedCredential> {
      if (request.auth.mode === "operator-oauth") {
        return missing(
          `${request.server} signs in as the person who runs the agent, and Oxagen does not hold operator tokens yet. Ask a workspace admin to give the server a service credential.`,
        );
      }
      const name = request.reference === undefined ? null : (REFERENCE.exec(request.reference)?.[1] ?? null);
      if (name === null) {
        return missing(`The ${request.environment} environment of ${request.server} names no credential. Add one in the steering record, then retry.`);
      }
      const row = await store.read(name);
      if (row === null) return missing(`Oxagen holds no credential named ${name}. Connect it in Oxagen, then retry.`);
      if (row.status !== "active") return missing(`The credential ${name} needs reconnecting. Connect it again in Oxagen, then retry.`);
      let secrets: CredentialSecrets | null;
      try {
        secrets = await store.decrypt(row);
      } catch {
        throw new ServedCredentialError(`Oxagen could not decrypt the credential ${name}.`);
      }
      if (secrets === null) throw new ServedCredentialError("This deployment holds no credential encryption key.");
      return apply(request, name, secrets);
    },
  };
}
