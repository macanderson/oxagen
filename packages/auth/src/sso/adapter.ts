/**
 * The Better Auth adapter wrapper that lets the @better-auth/sso plugin read
 * sealed provider secrets (ADR-145).
 *
 * The plugin reads `ssoProvider` rows through `ctx.context.adapter` and
 * `JSON.parse`s their oidcConfig / samlConfig text. Oxagen stores every secret
 * in that text as an envelope-encrypted token (@oxagen/database/sso-secrets),
 * so this wrapper opens the tokens on the way out and nothing else changes:
 * the column never holds a plaintext secret, and the plugin never sees a
 * token where it expects a secret.
 *
 * Only `findOne` opens anything. `findMany` returns every provider with its
 * secrets removed (#3740). The plugin lists all providers on a domain miss at
 * /sign-in/sso and keeps one of them, so opening them all decrypted every
 * organisation's secrets to serve one sign-in, and one row that could not be
 * opened failed the lookup for everyone. The select-provider plugin
 * (./select-provider-plugin.ts) resolves the provider before that listing
 * runs, so the plugin reaches the row it uses through `findOne`.
 *
 * Writes to `ssoProvider` through the adapter are refused. Oxagen's org.sso.*
 * capabilities own provider CRUD (they are where IAM, sealing and the audit
 * event happen), and the plugin's own register/update/delete/domain endpoints
 * are disabled in auth.ts. The refusal keeps a future plugin write path from
 * quietly storing plaintext.
 */
import type { BetterAuthOptions } from "better-auth";
import {
  openSsoConfig,
  stripSsoSecrets,
  type ResolvedSsoKms,
  type SsoProtocol,
} from "@oxagen/database/sso-secrets";

/** The plugin's model name for providers (before usePlural). */
export const SSO_PROVIDER_MODEL = "ssoProvider";

/** Every model name the adapter may be called with for providers. */
const PROVIDER_MODELS = new Set([SSO_PROVIDER_MODEL, "ssoProviders"]);

type Row = Record<string, unknown>;

// The adapter surface this wrapper touches. Structural, so it wraps whatever
// the Drizzle adapter (production) or the memory adapter (tests) returns.
interface WrappableAdapter {
  findOne: (
    data: { model: string } & Record<string, unknown>,
  ) => Promise<unknown>;
  findMany: (
    data: { model: string } & Record<string, unknown>,
  ) => Promise<unknown[]>;
  create: (
    data: { model: string } & Record<string, unknown>,
  ) => Promise<unknown>;
  update: (
    data: { model: string } & Record<string, unknown>,
  ) => Promise<unknown>;
  updateMany: (
    data: { model: string } & Record<string, unknown>,
  ) => Promise<number>;
  transaction: <R>(cb: (trx: never) => Promise<R>) => Promise<R>;
}

/** Thrown when anything tries to write a provider through Better Auth. */
export class SsoProviderWriteRefused extends Error {
  constructor() {
    super(
      "SSO providers are written by the org.sso.* capabilities, not through the auth adapter",
    );
    this.name = "SsoProviderWriteRefused";
  }
}

const CONFIG_FIELDS: readonly (readonly [string, SsoProtocol])[] = [
  ["oidcConfig", "oidc"],
  ["samlConfig", "saml"],
];

/** Open the sealed secrets in one provider row. */
export async function openSsoProviderRow(
  row: Row,
  kms: ResolvedSsoKms | null,
): Promise<Row> {
  const out = { ...row };
  for (const [field, protocol] of CONFIG_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value !== "") {
      out[field] = await openSsoConfig(protocol, value, kms);
    }
  }
  return out;
}

/**
 * One provider row with every secret removed and nothing opened. A config
 * that is not a JSON object becomes null, so a malformed row cannot fail a
 * listing.
 */
export function stripSsoProviderRow(row: Row): Row {
  const out = { ...row };
  for (const [field, protocol] of CONFIG_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value !== "") {
      out[field] = stripSsoSecrets(protocol, value);
    }
  }
  return out;
}

function wrapInstance<A extends WrappableAdapter>(
  adapter: A,
  resolveKms: () => ResolvedSsoKms | null,
): A {
  const isProvider = (model: string) => PROVIDER_MODELS.has(model);
  const wrapped: WrappableAdapter = {
    ...adapter,
    findOne: async (data) => {
      const row = await adapter.findOne(data);
      if (!isProvider(data.model) || row === null || typeof row !== "object") {
        return row;
      }
      return openSsoProviderRow(row as Row, resolveKms());
    },
    // Never opens: see the header. A caller that needs a provider's secrets
    // reads that one provider with findOne.
    findMany: async (data) => {
      const rows = await adapter.findMany(data);
      if (!isProvider(data.model)) return rows;
      return rows.map((row) =>
        row !== null && typeof row === "object"
          ? stripSsoProviderRow(row as Row)
          : row,
      );
    },
    create: async (data) => {
      if (isProvider(data.model)) throw new SsoProviderWriteRefused();
      return adapter.create(data);
    },
    update: async (data) => {
      if (isProvider(data.model)) throw new SsoProviderWriteRefused();
      return adapter.update(data);
    },
    updateMany: async (data) => {
      if (isProvider(data.model)) throw new SsoProviderWriteRefused();
      return adapter.updateMany(data);
    },
    transaction: (cb) =>
      adapter.transaction((trx) =>
        cb(wrapInstance(trx as unknown as A, resolveKms) as never),
      ),
  };
  return wrapped as A;
}

/**
 * Wrap a Better Auth adapter factory (`drizzleAdapter(db, …)` or
 * `memoryAdapter(…)`) so a provider row read with `findOne` comes back with
 * its secrets open, and a listing comes back with none. `resolveKms` is called
 * per `findOne`, so a key configured after boot is used.
 */
export function withSsoSecrets<A>(
  factory: (options: BetterAuthOptions) => A,
  resolveKms: () => ResolvedSsoKms | null,
): (options: BetterAuthOptions) => A {
  return (options) =>
    wrapInstance(
      factory(options) as unknown as WrappableAdapter,
      resolveKms,
    ) as unknown as A;
}
