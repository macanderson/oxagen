/**
 * Ask a model vendor whether an API key works, and whether each model the
 * credential maps can do what the assistant needs of it (ADR-053 §2, #3314).
 *
 * Three questions, in order.
 *
 * 1. IS THE KEY ACCEPTED? Each vendor exposes a metadata read that is
 *    authenticated the same way a completion is and costs nothing. A 2xx is
 *    the vendor saying "this key works here". Anything else is reported with
 *    the vendor's own text so an operator can fix the key rather than guess.
 *
 * 2. CAN EACH MAPPED MODEL CALL TOOLS? The in-app agent drives every turn by
 *    asking the model for tool calls and acting on them (`createProviderPort`),
 *    and `modelForRole` sends summaries and verdicts to the `fast` and
 *    `precise` tiers, not only to `balanced`. So on a direct credential
 *    (`openai`, `anthropic`, `openai_compatible`) the probe sends one real
 *    completion, with one tool offered and `tool_choice` forcing it, to every
 *    model the credential maps. It goes to the same OpenAI-compatible
 *    endpoint the runtime client calls. A typo in a mapping then fails here,
 *    when the key is saved, rather than on the first question. Each call is
 *    capped at a few output tokens, so the answer costs cents at most. The
 *    routed providers (`openrouter`, `gateway`) resolve the platform's own
 *    tier ids, which all call tools, so they are not asked.
 *
 * 3. DOES THE ENDPOINT HONOUR A JSON SCHEMA? Only for `openai_compatible`.
 *    `generateObjectFor` asks for a `response_format` JSON schema when the
 *    client says the endpoint supports one, and a Llama host or a self-hosted
 *    server may not. The probe sends one such request to the model structured
 *    calls run on (`fast`, else `balanced`) and reports whether the answer
 *    matched. The verify handler stores it, and the client sets
 *    `supportsStructuredOutputs` from what was stored.
 *
 * SECRET HANDLING: the key goes into one request header and nowhere else. It
 * is never logged, never part of a thrown error, and never part of the result
 * — a vendor message or a transport error that happened to echo the key is
 * scrubbed before it is returned.
 *
 * URL HANDLING: an `openai_compatible` endpoint is one a customer typed. This
 * module does not validate it — the handler does, with
 * `@oxagen/config/public-url`, BEFORE calling here, because a probe that
 * connects to `169.254.169.254` with the key attached has already leaked
 * whatever it was going to leak by the time it could refuse.
 */
import {
  fetchWithoutRedirects,
  redactUrlCredentials,
} from "@oxagen/config/public-url";
import type {
  ModelCredentialProvider,
  ModelCredentialTier,
} from "@oxagen/oxagen/contracts/org.model_credential.shared";
import { DIRECT_PROVIDER_BASE_URL } from "./direct-provider-urls";

/**
 * Every probe request goes out through this. The URL was checked by the
 * handler, but a redirect target is a URL nobody checked, so none is
 * followed: a 3xx is refused with its `Location` named, and the refusal
 * reaches the operator through `fail` like any other transport error.
 */
const probeFetch = fetchWithoutRedirects({ refusing: "Refusing to test" });

/** The vendors a key can be checked against — the `provider` column's CHECK. */
export type CredentialProbeProvider = ModelCredentialProvider;

export interface ProbeModelCredentialArgs {
  readonly provider: CredentialProbeProvider;
  /** The plaintext key. Never log, never serialise. */
  readonly apiKey: string;
  /**
   * The customer's endpoint, required for `openai_compatible` and ignored
   * otherwise. MUST already have passed `assertPublicHttpUrl`.
   */
  readonly baseUrl?: string | null;
  /**
   * The balanced tier's model, read as `{ balanced: toolProbeModel }` when
   * `toolProbeModels` is absent.
   *
   * @deprecated Pass `toolProbeModels`, which names every tier the runtime
   * can select (#3314). Kept for a caller that names only the balanced model.
   */
  readonly toolProbeModel?: string | null;
  /**
   * The model each tier maps to on this credential, from its `modelMap`
   * (#3314). The probe sends a completion with a tool to each one, because
   * `modelForRole` sends summaries and verdicts to `fast` and `precise`, not
   * only to `balanced`. Takes precedence over `toolProbeModel` when set.
   */
  readonly toolProbeModels?: Partial<
    Record<ModelCredentialTier, string>
  > | null;
}

export interface CredentialProbeResult {
  /** True when the vendor accepted the key. */
  readonly ok: boolean;
  /** Whole milliseconds from the first request to the last answer. */
  readonly latencyMs: number;
  /**
   * The vendor's message about the key when it was refused, `HTTP <status>`
   * when the vendor sent no message, or the transport error (network, DNS,
   * timeout) when no answer arrived. When the key was accepted and a mapped
   * model could not call tools, the reason, prefixed with that tier and its
   * model. Null otherwise.
   */
  readonly error: string | null;
  /**
   * Whether every mapped model returned a tool call when forced to. `false`
   * when any tier's model did not, `null` when one ran out of output before
   * it answered or the key was refused so the question never came up, and
   * `true` for a routed provider or a named vendor with no mapping, which
   * are not asked.
   */
  readonly toolCalling: boolean | null;
  /**
   * The tool-calling answer for each tier in `toolProbeModels` (#3314). A
   * tier the probe did not ask is absent.
   */
  readonly toolCallingByTier?: Partial<
    Record<ModelCredentialTier, boolean | null>
  >;
  /** The first tier whose model could not serve a tool call; null when none failed. */
  readonly failingTier?: ModelCredentialTier | null;
  /**
   * Whether an `openai_compatible` endpoint honoured a `response_format`
   * JSON-schema request (#3314). Null when it was not asked, which is every
   * other provider and a refused key.
   */
  readonly structuredOutputs?: boolean | null;
}

/**
 * How long one probe request may take. A vendor that has not answered in ten
 * seconds is not going to serve a completion either, and the settings page is
 * waiting on this behind a button.
 */
export const CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;

/**
 * The token-free, key-authenticated endpoint per provider whose URL Oxagen
 * spells. `openai_compatible` is absent: it is probed at `<baseUrl>/models`,
 * the one route every OpenAI-compatible server is expected to serve.
 */
export const CREDENTIAL_PROBE_URL: Readonly<
  Record<Exclude<CredentialProbeProvider, "openai_compatible">, string>
> = {
  openrouter: "https://openrouter.ai/api/v1/auth/key",
  gateway: "https://ai-gateway.vercel.sh/v1/models",
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
};

const REDACTED = "[redacted]";

/** Whole milliseconds since `startedAt`, never negative. */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/**
 * Take every secret out of a vendor or transport message. Both are text we did
 * not write, so neither is trusted not to echo what it was given.
 *
 * Two secrets can be in one: the key, which travels in a header, and a
 * credential embedded in the endpoint itself. `assertPublicHttpUrl` refuses an
 * endpoint with userinfo, so a customer cannot store one today — but a row
 * written before that guard existed still probes, and Node answers it with
 * "Request cannot be constructed from a URL that includes credentials:
 * https://user:pass@…", which this result hands straight back to the settings
 * page. The URL redaction is what keeps that password out of the answer.
 */
function scrub(text: string, apiKey: string): string {
  const withoutKey =
    apiKey.length > 0 ? text.split(apiKey).join(REDACTED) : text;
  return redactUrlCredentials(withoutKey);
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * The headers a key goes in, per provider. Anthropic's native metadata route
 * authenticates with `x-api-key` plus a version header rather than a bearer
 * token, and a bearer token there is a 401 that would tell an operator their
 * perfectly good key is wrong.
 */
function authHeaders(
  provider: CredentialProbeProvider,
  apiKey: string,
): Record<string, string> {
  if (provider === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * The vendor's own reason for a non-2xx answer: `error.message` from a JSON
 * body when there is one, otherwise the status line. A body that is not JSON
 * is not an error here — an HTML 502 from a proxy is still a refusal.
 */
async function vendorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string" &&
      body.error.message.length > 0
    ) {
      return body.error.message;
    }
  } catch {
    // Not JSON, or an unreadable body: the status is all the vendor said.
  }
  return fallback;
}

/** Where to ask question 1 for this credential. */
function keyProbeUrl(args: ProbeModelCredentialArgs): string | null {
  if (args.provider === "openai_compatible") {
    return args.baseUrl ? endpointUrl(args.baseUrl, "models") : null;
  }
  return CREDENTIAL_PROBE_URL[args.provider];
}

/** The tiers a credential maps, in the order the probe reports them. */
const PROBE_TIERS: readonly ModelCredentialTier[] = [
  "fast",
  "balanced",
  "precise",
];

/**
 * Where a credential's completions go: the OpenAI-compatible endpoint the
 * runtime client calls (`customerClient` in `models.ts`). Null for a routed
 * provider, which is not asked.
 */
function chatBaseUrl(args: ProbeModelCredentialArgs): string | null {
  switch (args.provider) {
    case "openai":
    case "anthropic":
      return DIRECT_PROVIDER_BASE_URL[args.provider];
    case "openai_compatible":
      return args.baseUrl ?? null;
    default:
      return null;
  }
}

/** The model each tier maps to, from `toolProbeModels`, else `toolProbeModel` as `balanced`. */
function tierModels(
  args: ProbeModelCredentialArgs,
): Partial<Record<ModelCredentialTier, string>> {
  const models: Partial<Record<ModelCredentialTier, string>> = {};
  if (args.toolProbeModels) {
    for (const tier of PROBE_TIERS) {
      const model = args.toolProbeModels[tier]?.trim();
      if (model) models[tier] = model;
    }
    return models;
  }
  const balanced = args.toolProbeModel?.trim();
  if (balanced) models.balanced = balanced;
  return models;
}

/**
 * The output cap for one probe completion. OpenAI refuses `max_tokens` on
 * its reasoning models and takes `max_completion_tokens` on every chat
 * model, and a reasoning model spends part of the cap before it calls the
 * tool, so its cap leaves room for that. A forced call with no arguments is
 * about 20 tokens on Anthropic. An OpenAI-compatible server keeps the 16
 * tokens it has always been asked for.
 */
function outputCap(provider: CredentialProbeProvider): Record<string, number> {
  if (provider === "openai") return { max_completion_tokens: 1024 };
  if (provider === "anthropic") return { max_tokens: 64 };
  return { max_tokens: 16 };
}

interface ChatChoice {
  finish_reason?: string | null;
  message?: { tool_calls?: unknown[]; content?: unknown };
}

/** POST one chat completion to a credential's endpoint, with the key as a bearer token. */
function postChat(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return probeFetch(endpointUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CREDENTIAL_PROBE_TIMEOUT_MS),
  });
}

/**
 * Ask one model for a forced tool call and report whether one came back.
 * One trivial tool and `tool_choice` naming it: a model that supports
 * function calling has no choice but to call it, so a plain-text answer is a
 * clear "no".
 *
 * A non-2xx is reported as `false` rather than as a key failure. The key
 * already passed question 1, so a refusal now is the endpoint declining the
 * model or the `tools` parameter, which is the answer being asked for. The
 * vendor's message is returned so the settings page can show why. A model
 * that ran out of output tokens before it answered is `null`: the question
 * was asked and not answered.
 */
async function probeToolCalling(
  provider: CredentialProbeProvider,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ supported: boolean | null; message: string | null }> {
  const response = await postChat(baseUrl, apiKey, {
    model,
    ...outputCap(provider),
    messages: [{ role: "user", content: "Call the ping tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "ping",
          description: "Reply to a ping.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "ping" } },
  });
  if (!response.ok) {
    return { supported: false, message: await vendorMessage(response) };
  }
  const body = (await response.json()) as { choices?: ChatChoice[] };
  const choice = body.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    return { supported: true, message: null };
  }
  if (choice?.finish_reason === "length") {
    return {
      supported: null,
      message: "the model reached its output limit before it answered",
    };
  }
  return { supported: false, message: null };
}

/** The JSON schema the structured-output question asks for. */
const STRUCTURED_PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

/**
 * Ask an `openai_compatible` model for an answer under a `response_format`
 * JSON schema, in the shape `@ai-sdk/openai-compatible` sends when
 * `supportsStructuredOutputs` is on, and report whether the answer matched
 * it. A refusal, prose, or JSON of another shape is `false`. A transport
 * failure is `null`: the question was not answered, and the credential is
 * then treated as unprobed.
 */
async function probeStructuredOutputs(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<boolean | null> {
  try {
    const response = await postChat(baseUrl, apiKey, {
      model,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: 'Answer with the JSON object {"ok": true} and nothing else.',
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: STRUCTURED_PROBE_SCHEMA,
          strict: true,
          name: "response",
        },
      },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { choices?: ChatChoice[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return false;
    const parsed: unknown = JSON.parse(content);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { ok?: unknown }).ok === "boolean"
    );
  } catch (err) {
    // Unparseable content is the endpoint ignoring the schema. Anything else
    // thrown is transport: DNS, a refused connection, or the timeout.
    return err instanceof SyntaxError ? false : null;
  }
}

/**
 * Check one credential against its vendor. Never throws: a refusal, a timeout
 * and a network failure are all answers the caller reports, and the settings
 * page shows the operator whichever one came back.
 */
export async function probeModelCredential(
  args: ProbeModelCredentialArgs,
): Promise<CredentialProbeResult> {
  const { provider, apiKey } = args;
  const startedAt = performance.now();
  const fail = (message: string): CredentialProbeResult => ({
    ok: false,
    latencyMs: elapsedMs(startedAt),
    error: scrub(message, apiKey),
    toolCalling: null,
  });

  const url = keyProbeUrl(args);
  if (!url) return fail("an openai_compatible credential needs a base URL");

  try {
    const response = await probeFetch(url, {
      method: "GET",
      headers: authHeaders(provider, apiKey),
      signal: AbortSignal.timeout(CREDENTIAL_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return fail(await vendorMessage(response));

    const chatUrl = chatBaseUrl(args);
    const models = tierModels(args);
    const tiers = PROBE_TIERS.filter((tier) => models[tier] !== undefined);
    if (chatUrl === null || tiers.length === 0) {
      // A routed provider is not asked: its tier ids all call tools. A named
      // vendor with no mapping is a candidate checked before its map was
      // typed, so the answer is the vendor's known one. An
      // `openai_compatible` endpoint cannot be asked without a model; the
      // handler refuses to save one with no balanced-tier model, so this is
      // a verify called on a partial form.
      return {
        ok: true,
        latencyMs: elapsedMs(startedAt),
        error: null,
        toolCalling: provider === "openai_compatible" ? null : true,
        structuredOutputs: null,
      };
    }

    // Question 2: each distinct model once, in parallel, so a credential
    // that maps one model to every tier pays for one completion.
    const distinct = [...new Set(tiers.map((tier) => models[tier]!))];
    const answers = new Map(
      await Promise.all(
        distinct.map(
          async (model) =>
            [
              model,
              await probeToolCalling(provider, chatUrl, apiKey, model),
            ] as const,
        ),
      ),
    );
    const byTier: Partial<Record<ModelCredentialTier, boolean | null>> = {};
    for (const tier of tiers) {
      byTier[tier] = answers.get(models[tier]!)!.supported;
    }
    const failingTier = tiers.find((tier) => byTier[tier] === false) ?? null;
    const unanswered = tiers.find((tier) => byTier[tier] === null);
    const toolCalling =
      failingTier !== null ? false : unanswered !== undefined ? null : true;
    const named = failingTier ?? unanswered;
    const reason =
      named === undefined ? null : answers.get(models[named]!)!.message;

    // Question 3, on the model structured calls run on.
    const structuredModel = models.fast ?? models.balanced;
    const structuredOutputs =
      provider === "openai_compatible" && structuredModel !== undefined
        ? await probeStructuredOutputs(chatUrl, apiKey, structuredModel)
        : null;

    return {
      ok: true,
      latencyMs: elapsedMs(startedAt),
      error:
        named === undefined || reason === null
          ? null
          : scrub(`${named} tier (${models[named]}): ${reason}`, apiKey),
      toolCalling,
      toolCallingByTier: byTier,
      failingTier,
      structuredOutputs,
    };
  } catch (err) {
    // A thrown fetch is transport: DNS, a refused connection, or the timeout
    // signal firing (a `TimeoutError` DOMException). Its message is the
    // operator's clue and carries no header, but it is scrubbed anyway.
    return fail(err instanceof Error ? err.message : String(err));
  }
}
