// test-support.ts: what the credential tests run against. Production code does
// not import it.
//
// MemoryCredentialStore keeps the Postgres store's rules: saveOperatorToken
// replaces the operator's row for the same server and environment, and every
// write sets the status the Postgres store sets. MemoryConnectStateStore
// stores each state as JSON and reads it back through connectStateSchema, as
// auth.verifications does. scriptedFetch plays an authorization server and
// records every request it was sent.
import { randomBytes, randomUUID } from "node:crypto";
import type { ManifestAuth, ManifestServer } from "@oxagen/mcp-studio";
import {
  decryptCredentialSecrets,
  encryptCredentialSecrets,
  resolveCredentialKms,
  type ResolvedKms,
} from "@oxagen/plugins";
import type { FetchLike } from "./oauth";
import {
  type ConnectState,
  type ConnectStateStore,
  connectStateSchema,
  type CredentialStore,
  type CredentialTokenUpdate,
  type CredentialValue,
  type NewOperatorToken,
  type OperatorKey,
  type OperatorTokenUpdate,
  type StoredCredential,
  type StoredOperatorToken,
} from "./store";

/** A vault key made for one test file. The environment is left as it was. */
export function testKms(): ResolvedKms {
  const previous = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    const kms = resolveCredentialKms();
    if (kms === null) throw new Error("resolveCredentialKms returned null with a key set");
    return kms;
  } finally {
    if (previous === undefined) delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.AUTH_TOKEN_ENCRYPTION_KEY = previous;
  }
}

/** An mcp.credentials row, with its secrets in plaintext. */
export interface CredentialSeed {
  name: string;
  authKind?: "oauth" | "secret";
  status?: "active" | "needs_reauth" | "revoked";
  oauthClientId?: string | null;
  scopes?: string[];
  expiresAt?: Date | null;
  lastRefreshedAt?: Date | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  secret?: string | null;
  oauthClientSecret?: string | null;
}

/** An mcp.operator_tokens row, with its secrets in plaintext. */
export interface OperatorTokenSeed extends OperatorKey {
  accessToken: string;
  refreshToken?: string | null;
  clientSecret?: string | null;
  clientId?: string;
  credentialId?: string | null;
  tokenEndpoint?: string;
  revocationEndpoint?: string | null;
  scopes?: string[];
  expiresAt?: Date | null;
  status?: "active" | "needs_reauth";
  lastRefreshedAt?: Date | null;
}

/** The plaintext of a row's sealed columns. */
export interface OpenedSecrets {
  accessToken: string | null;
  refreshToken: string | null;
  secret: string | null;
  oauthClientSecret: string | null;
}

/** The credential rows of one workspace, in memory. */
export class MemoryCredentialStore implements CredentialStore {
  readonly credentials = new Map<string, StoredCredential>();
  readonly tokens = new Map<string, StoredOperatorToken>();
  readonly members = new Set<string>();
  /** Every write, in order, as "<method> <id>". */
  readonly writes: string[] = [];

  constructor(private readonly kms: ResolvedKms) {}

  async addCredential(seed: CredentialSeed): Promise<StoredCredential> {
    const sealed = await encryptCredentialSecrets(
      {
        accessToken: seed.accessToken ?? null,
        refreshToken: seed.refreshToken ?? null,
        secret: seed.secret ?? null,
        oauthClientSecret: seed.oauthClientSecret ?? null,
      },
      this.kms,
    );
    const row: StoredCredential = {
      id: randomUUID(),
      name: seed.name,
      authKind: seed.authKind ?? "secret",
      status: seed.status ?? "active",
      oauthClientId: seed.oauthClientId ?? null,
      scopes: seed.scopes ?? [],
      expiresAt: seed.expiresAt ?? null,
      lastRefreshedAt: seed.lastRefreshedAt ?? null,
      ...sealed,
    };
    this.credentials.set(row.id, row);
    return { ...row };
  }

  async addOperatorToken(seed: OperatorTokenSeed): Promise<StoredOperatorToken> {
    const sealed = await encryptCredentialSecrets(
      {
        accessToken: seed.accessToken,
        refreshToken: seed.refreshToken ?? null,
        oauthClientSecret: seed.clientSecret ?? null,
      },
      this.kms,
    );
    if (sealed.accessTokenEnc === null) throw new Error("an operator token needs an access token");
    const row: StoredOperatorToken = {
      id: randomUUID(),
      userId: seed.userId,
      server: seed.server,
      environment: seed.environment,
      credentialId: seed.credentialId ?? null,
      clientId: seed.clientId ?? "client-1",
      clientSecretEnc: sealed.oauthClientSecretEnc,
      tokenEndpoint: seed.tokenEndpoint ?? "https://auth.example.com/token",
      revocationEndpoint: seed.revocationEndpoint ?? null,
      accessTokenEnc: sealed.accessTokenEnc,
      refreshTokenEnc: sealed.refreshTokenEnc,
      tokenKmsKeyId: sealed.tokenKmsKeyId,
      scopes: seed.scopes ?? [],
      expiresAt: seed.expiresAt ?? null,
      status: seed.status ?? "active",
      lastRefreshedAt: seed.lastRefreshedAt ?? null,
    };
    this.tokens.set(row.id, row);
    return { ...row };
  }

  /** Decrypt a credential row, for assertions. */
  async openCredential(id: string): Promise<OpenedSecrets> {
    const row = this.credentials.get(id);
    if (row === undefined) throw new Error(`no credential ${id}`);
    return decryptCredentialSecrets(row, this.kms);
  }

  /** Decrypt an operator token row, for assertions. */
  async openToken(id: string): Promise<OpenedSecrets> {
    const row = this.tokens.get(id);
    if (row === undefined) throw new Error(`no operator token ${id}`);
    return decryptCredentialSecrets(
      {
        tokenKmsKeyId: row.tokenKmsKeyId,
        accessTokenEnc: row.accessTokenEnc,
        refreshTokenEnc: row.refreshTokenEnc,
        oauthClientSecretEnc: row.clientSecretEnc,
      },
      this.kms,
    );
  }

  /** The operator's row for one server and environment, for assertions. */
  tokenFor(key: OperatorKey): StoredOperatorToken | undefined {
    for (const row of this.tokens.values()) {
      if (row.userId === key.userId && row.server === key.server && row.environment === key.environment) {
        return row;
      }
    }
    return undefined;
  }

  async credentialByName(name: string): Promise<StoredCredential | null> {
    for (const row of this.credentials.values()) {
      if (row.name === name) return { ...row };
    }
    return null;
  }

  async credentialById(id: string): Promise<StoredCredential | null> {
    const row = this.credentials.get(id);
    return row === undefined ? null : { ...row };
  }

  async saveCredentialTokens(id: string, update: CredentialTokenUpdate): Promise<void> {
    this.writes.push(`saveCredentialTokens ${id}`);
    const row = this.credentials.get(id);
    if (row === undefined) return;
    this.credentials.set(id, {
      ...row,
      ...update.sealed,
      expiresAt: update.expiresAt,
      scopes: update.scopes,
      status: "active",
      lastRefreshedAt: update.refreshedAt,
    });
  }

  async markCredentialNeedsReauth(id: string): Promise<void> {
    this.writes.push(`markCredentialNeedsReauth ${id}`);
    const row = this.credentials.get(id);
    if (row !== undefined) this.credentials.set(id, { ...row, status: "needs_reauth" });
  }

  async setCredential(value: CredentialValue): Promise<{ id: string; created: boolean }> {
    const existing = await this.credentialByName(value.name);
    const id = existing?.id ?? randomUUID();
    this.writes.push(`setCredential ${id}`);
    this.credentials.set(id, {
      id,
      name: value.name,
      authKind: value.authKind,
      status: "active",
      oauthClientId: value.oauthClientId,
      scopes: [],
      expiresAt: null,
      lastRefreshedAt: null,
      ...value.sealed,
    });
    return { id, created: existing === null };
  }

  async operatorToken(key: OperatorKey): Promise<StoredOperatorToken | null> {
    const row = this.tokenFor(key);
    return row === undefined ? null : { ...row };
  }

  async saveOperatorToken(row: NewOperatorToken): Promise<void> {
    const id = this.tokenFor(row)?.id ?? randomUUID();
    this.writes.push(`saveOperatorToken ${id}`);
    this.tokens.set(id, { ...row, id, status: "active" });
  }

  async updateOperatorToken(id: string, update: OperatorTokenUpdate): Promise<void> {
    this.writes.push(`updateOperatorToken ${id}`);
    const row = this.tokens.get(id);
    if (row === undefined) return;
    this.tokens.set(id, {
      ...row,
      accessTokenEnc: update.accessTokenEnc,
      refreshTokenEnc: update.refreshTokenEnc,
      clientSecretEnc: update.clientSecretEnc,
      tokenKmsKeyId: update.tokenKmsKeyId,
      expiresAt: update.expiresAt,
      scopes: update.scopes,
      status: "active",
      lastRefreshedAt: update.refreshedAt,
    });
  }

  async markOperatorTokenNeedsReauth(id: string): Promise<void> {
    this.writes.push(`markOperatorTokenNeedsReauth ${id}`);
    const row = this.tokens.get(id);
    if (row !== undefined) this.tokens.set(id, { ...row, status: "needs_reauth" });
  }

  async deleteOperatorToken(id: string): Promise<boolean> {
    this.writes.push(`deleteOperatorToken ${id}`);
    return this.tokens.delete(id);
  }

  async operatorTokensOf(userId: string): Promise<StoredOperatorToken[]> {
    return [...this.tokens.values()].filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }

  async isMember(userId: string): Promise<boolean> {
    return this.members.has(userId);
  }
}

/** Connect states in memory, stored as JSON the way auth.verifications stores them. */
export class MemoryConnectStateStore implements ConnectStateStore {
  readonly rows = new Map<string, { value: string; expiresAt: Date }>();

  async save(state: string, data: ConnectState, expiresAt: Date): Promise<void> {
    this.rows.set(state, { value: JSON.stringify(data), expiresAt });
  }

  async take(state: string, now: Date): Promise<ConnectState | null> {
    const row = this.rows.get(state);
    this.rows.delete(state);
    if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return null;
    const parsed = connectStateSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  }
}

/** One request the scripted authorization server received. */
export interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** A form body's fields. */
  form: URLSearchParams | null;
  /** A JSON body. */
  json: unknown;
}

export type ScriptedFetch = FetchLike & { sent: SentRequest[] };

/** A fetch that answers every request with `answer` and records it. */
export function scriptedFetch(
  answer: (request: SentRequest) => Response | Promise<Response>,
): ScriptedFetch {
  const sent: SentRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    const body = typeof init.body === "string" ? init.body : null;
    const isForm = headers["content-type"] === "application/x-www-form-urlencoded";
    const request: SentRequest = {
      url: input,
      method: init.method ?? "GET",
      headers,
      form: isForm && body !== null ? new URLSearchParams(body) : null,
      json: !isForm && body !== null ? (JSON.parse(body) as unknown) : null,
    };
    sent.push(request);
    return answer(request);
  };
  return Object.assign(fetchImpl, { sent });
}

/** A fetch for a test that expects no request. */
export function noFetch(): ScriptedFetch {
  return scriptedFetch((request) => {
    throw new Error(`unexpected request to ${request.url}`);
  });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** HTTP Basic client authentication, as the authorization server reads it. */
export function basicClient(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (header === undefined || !header.startsWith("Basic ")) return null;
  const pair = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const colon = pair.indexOf(":");
  return {
    clientId: decodeURIComponent(pair.slice(0, colon)),
    clientSecret: decodeURIComponent(pair.slice(colon + 1)),
  };
}

/** A published server with the fields the credential code reads. */
export function manifestServer(input: {
  name?: string;
  label?: string;
  auth: ManifestAuth | null;
  environments?: Record<string, { url?: string; network?: string; credential?: string }>;
}): ManifestServer {
  const environments = input.environments ?? { sandbox: { url: "https://billing.example.com/mcp" } };
  return {
    name: input.name ?? "billing",
    label: input.label ?? "Billing API",
    auth: input.auth,
    environments: Object.fromEntries(
      Object.entries(environments).map(([name, env]) => [
        name,
        {
          sandbox: name === "sandbox",
          network: env.network ?? "cloud",
          ...(env.url === undefined ? {} : { url: env.url }),
          ...(env.credential === undefined ? {} : { credential: env.credential }),
        },
      ]),
    ),
  } as unknown as ManifestServer;
}
