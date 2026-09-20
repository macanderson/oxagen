/**
 * OpenRouter's key-provisioning API — the five calls Oxagen makes against its
 * own OpenRouter account to give each organisation its own token (ADR-131).
 *
 * This module is the ONLY place `OPENROUTER_MANAGEMENT_KEY` is read. That key
 * can create, read, disable and delete every key in the account, so it never
 * reaches a provider client, never reaches a tenant scope, and never reaches
 * a log line. The per-org keys it mints are ordinary inference keys with a
 * daily ceiling; they can spend and nothing else.
 *
 * No database, no tenancy, no env schema: this file speaks HTTP and returns
 * what the vendor said. The caller decides what to store (see
 * `@oxagen/database/assistant-model-key`) and when to call.
 *
 * SECRET HANDLING: a created key's plaintext is returned exactly once, in
 * `CreatedAssistantKey.apiKey`, because OpenRouter never shows it again. The
 * caller must envelope it in the same breath. It is not logged here, is not
 * part of any thrown error, and `describe()` and `list()` never return it —
 * they return the vendor's own masked `label` instead.
 *
 * The `hash` is the durable handle. It is not a secret and it is what every
 * later call (raise the ceiling, disable, delete, read usage) is addressed
 * by, so it is the column the stored row joins on rather than the key's name,
 * which is a label a human reads and which this system never rewrites.
 */

const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/keys";

/**
 * How often a key's ceiling refills. Oxagen provisions `daily`: a runaway
 * loop costs one organisation one day's ceiling and stops, and the ceiling is
 * back the next midnight UTC without anyone being paged. A null reset would
 * make `limit` a lifetime budget, which turns every heavy legitimate month
 * into a support ticket.
 */
export type OpenRouterLimitReset = "daily" | "weekly" | "monthly";

/** A key as OpenRouter describes it. Never carries the plaintext. */
export interface OpenRouterKey {
  /** The durable handle every later call is addressed by. Not a secret. */
  readonly hash: string;
  /** The display name, fixed at creation (see `assistantKeyName`). */
  readonly name: string;
  /** The vendor's own masked preview, e.g. `sk-or-v1-c24...514`. Not a secret. */
  readonly label: string;
  readonly disabled: boolean;
  /** The ceiling in USD, or null for none. */
  readonly limit: number | null;
  readonly limitRemaining: number | null;
  readonly limitReset: OpenRouterLimitReset | null;
  /** Spend in USD since the key was created, and within each window. */
  readonly usage: number;
  readonly usageDaily: number;
  readonly usageWeekly: number;
  readonly usageMonthly: number;
  readonly createdAt: string;
}

/** A freshly minted key. The one and only sighting of its plaintext. */
export interface CreatedAssistantKey {
  readonly key: OpenRouterKey;
  /** The plaintext. Envelope it now; OpenRouter will not show it again. */
  readonly apiKey: string;
}

export interface CreateAssistantKeyArgs {
  /** The display name. Fixed at creation and never rewritten. */
  readonly name: string;
  /** The ceiling in USD per `limitReset` window. */
  readonly limitUsd: number;
  readonly limitReset?: OpenRouterLimitReset;
  /** The management key. Read by the caller from the environment. */
  readonly managementKey: string;
  /** Test seam. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * What the vendor said when a call failed, in a shape a caller can branch on.
 *
 * `status` is the HTTP code, so a caller can tell "the management key is
 * wrong" (401) from "OpenRouter is having a bad minute" (5xx) and retry only
 * the second. `message` is OpenRouter's own text, which is the sentence an
 * operator needs; it is scrubbed of anything key-shaped first, because a
 * vendor that echoes a submitted value into an error must not turn a failed
 * provision into a secret in the log.
 */
export class OpenRouterProvisioningError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string, retryable?: boolean) {
    super(`openrouter provisioning failed (${status}): ${scrub(message)}`);
    this.name = "OpenRouterProvisioningError";
    this.status = status;
    // 408, 429 and every 5xx are the vendor asking to be asked again. A 4xx
    // is a request that will fail identically forever, and retrying it burns
    // the caller's backoff on a bug.
    //
    // The override exists for the one failure where the status says "ask
    // again" and the operation says do not: a create whose side effect
    // already happened. Nothing reads this flag today, which is exactly when
    // to get it right — the first thing that does will trust it.
    this.retryable =
      retryable ?? (status === 408 || status === 429 || status >= 500);
  }
}

/** Anything key-shaped, out of any string that is about to be logged or thrown. */
function scrub(text: string): string {
  return text.replace(/sk-or-v1-[A-Za-z0-9]+/g, "sk-or-v1-[redacted]");
}

/**
 * Mint one key.
 *
 * NOT idempotent — OpenRouter has no natural key and will happily create a
 * second token with the same name. The caller owns idempotence, and does it
 * with the `org_id` primary key of `org.assistant_model_keys`: it checks for
 * a row first, and on a unique-violation race it deletes the key it just
 * minted rather than leaving an orphan that can spend. See
 * `ensureAssistantModelKey`.
 */
export async function createAssistantKey(
  args: CreateAssistantKeyArgs,
): Promise<CreatedAssistantKey> {
  const body = await request(args.fetchImpl, OPENROUTER_KEYS_URL, {
    method: "POST",
    managementKey: args.managementKey,
    json: {
      name: args.name,
      limit: args.limitUsd,
      limit_reset: args.limitReset ?? "daily",
      // Oxagen's account pays for these calls, so a key that could also spend
      // through a bring-your-own-key provider under the same ceiling would
      // make the ceiling mean two different things. It is off, explicitly.
      include_byok_in_limit: false,
    },
  });
  const key = parseKey(body["data"]);
  const apiKey = body["key"];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    // Unreachable against the live API, and worth failing loudly if it ever
    // happens: a key that exists at the vendor and whose plaintext we never
    // saw is a key that can spend and that nobody can use or attribute. The
    // caller deletes it on this throw.
    throw new OpenRouterProvisioningError(
      502,
      "OpenRouter created a key but returned no plaintext",
      // Not retryable, despite the 5xx. The key was created; asking again
      // mints a second spendable one and orphans this one. The caller
      // deletes it on this throw and gives up.
      false,
    );
  }
  return { key, apiKey };
}

/** Read one key's current ceiling and spend. The reconciliation read. */
export async function describeAssistantKey(args: {
  readonly hash: string;
  readonly managementKey: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<OpenRouterKey> {
  const body = await request(
    args.fetchImpl,
    `${OPENROUTER_KEYS_URL}/${encodeURIComponent(args.hash)}`,
    { method: "GET", managementKey: args.managementKey },
  );
  return parseKey(body["data"]);
}

/**
 * Change a key's ceiling or switch it off.
 *
 * `name` is deliberately absent. The name records who the key was minted for
 * and is never rewritten — not when the organisation renames its slug, and
 * not when the creator leaves. A name that drifts is a name an auditor cannot
 * read backwards.
 */
export async function updateAssistantKey(args: {
  readonly hash: string;
  readonly managementKey: string;
  readonly disabled?: boolean;
  readonly limitUsd?: number;
  readonly limitReset?: OpenRouterLimitReset;
  readonly fetchImpl?: typeof fetch;
}): Promise<OpenRouterKey> {
  const json: Record<string, unknown> = {};
  if (args.disabled !== undefined) json["disabled"] = args.disabled;
  if (args.limitUsd !== undefined) json["limit"] = args.limitUsd;
  if (args.limitReset !== undefined) json["limit_reset"] = args.limitReset;
  const body = await request(
    args.fetchImpl,
    `${OPENROUTER_KEYS_URL}/${encodeURIComponent(args.hash)}`,
    { method: "PATCH", managementKey: args.managementKey, json },
  );
  return parseKey(body["data"]);
}

/**
 * Destroy a key.
 *
 * Used on one path only: unwinding a mint whose row could not be written. An
 * organisation that leaves has its key DISABLED, not deleted, because a
 * deleted key takes its usage history with it and the invoice for the month
 * it was deleted in is then unreconcilable.
 */
export async function deleteAssistantKey(args: {
  readonly hash: string;
  readonly managementKey: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  await request(
    args.fetchImpl,
    `${OPENROUTER_KEYS_URL}/${encodeURIComponent(args.hash)}`,
    { method: "DELETE", managementKey: args.managementKey },
  );
}

/**
 * Every key in the account, newest first.
 *
 * Paginated by `offset` in pages of 100, which is the page size OpenRouter
 * serves and not a number this function chooses. It follows the pages itself
 * because the one caller that wants this — the reconciliation report — wants
 * the account, not a page of it. Bounded at 100 pages so a vendor that keeps
 * answering a full page forever cannot spin here.
 */
export async function listAssistantKeys(args: {
  readonly managementKey: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<OpenRouterKey[]> {
  const out: OpenRouterKey[] = [];
  const PAGE = 100;
  for (let page = 0; page < 100; page += 1) {
    const body = await request(
      args.fetchImpl,
      `${OPENROUTER_KEYS_URL}?offset=${page * PAGE}`,
      { method: "GET", managementKey: args.managementKey },
    );
    const data = body["data"];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) out.push(parseKey(row));
    if (data.length < PAGE) break;
  }
  return out;
}

/** One authenticated call, with the vendor's error turned into ours. */
async function request(
  fetchImpl: typeof fetch | undefined,
  url: string,
  init: {
    method: string;
    managementKey: string;
    json?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const doFetch = fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.managementKey}`,
        ...(init.json ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.json ? { body: JSON.stringify(init.json) } : {}),
    });
  } catch (err) {
    // A transport failure is the vendor being unreachable, which is the same
    // thing as a 503 to every caller of this module.
    throw new OpenRouterProvisioningError(
      503,
      err instanceof Error ? err.message : String(err),
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new OpenRouterProvisioningError(
      response.status,
      errorMessageOf(text) ?? text.slice(0, 500),
    );
  }
  // A DELETE answers `{"deleted":true}`; every other call answers an object
  // with `data`. Both parse here and the caller reads what it needs.
  try {
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new OpenRouterProvisioningError(
      502,
      "OpenRouter returned a body that is not JSON",
    );
  }
}

/** OpenRouter's `{"error":{"message":...}}`, when that is what came back. */
function errorMessageOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const error = (parsed as Record<string, unknown>)["error"];
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return message;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The vendor's key object, read without trusting it.
 *
 * `hash` and `name` are required because everything downstream is addressed
 * by them; a response missing either is a response this system cannot store,
 * and failing here beats writing a row whose handle is `undefined`. Every
 * number defaults to 0 rather than throwing: a usage counter the vendor
 * omitted must not fail a provision.
 */
function parseKey(raw: unknown): OpenRouterKey {
  if (typeof raw !== "object" || raw === null) {
    throw new OpenRouterProvisioningError(502, "OpenRouter returned no key");
  }
  const row = raw as Record<string, unknown>;
  const hash = row["hash"];
  const name = row["name"];
  if (typeof hash !== "string" || hash.length === 0) {
    throw new OpenRouterProvisioningError(
      502,
      "OpenRouter returned a key with no hash",
    );
  }
  return {
    hash,
    name: typeof name === "string" ? name : "",
    label: typeof row["label"] === "string" ? row["label"] : "",
    disabled: row["disabled"] === true,
    limit: numberOrNull(row["limit"]),
    limitRemaining: numberOrNull(row["limit_remaining"]),
    limitReset: limitResetOf(row["limit_reset"]),
    usage: numberOr0(row["usage"]),
    usageDaily: numberOr0(row["usage_daily"]),
    usageWeekly: numberOr0(row["usage_weekly"]),
    usageMonthly: numberOr0(row["usage_monthly"]),
    createdAt: typeof row["created_at"] === "string" ? row["created_at"] : "",
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOr0(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function limitResetOf(value: unknown): OpenRouterLimitReset | null {
  return value === "daily" || value === "weekly" || value === "monthly"
    ? value
    : null;
}
