/**
 * Ask a model vendor whether an API key works — and whether the endpoint can
 * do the one thing the assistant cannot run without (ADR-053 §2).
 *
 * Two questions, in order.
 *
 * 1. IS THE KEY ACCEPTED? Each vendor exposes a metadata read that is
 *    authenticated the same way a completion is and costs nothing. A 2xx is
 *    the vendor saying "this key works here"; anything else is reported with
 *    the vendor's own text so an operator can fix the key rather than guess.
 *
 * 2. CAN IT CALL TOOLS? The in-app agent drives every turn by asking the
 *    model for tool calls and acting on them (`createProviderPort`); the
 *    engine holds no tools and no key of its own. An endpoint that
 *    authenticates perfectly and cannot call tools produces an assistant that
 *    answers nothing about the workspace — and the customer would find that
 *    out on their first question rather than when they saved the key. This is
 *    asked only of the providers where the answer is not already known: the
 *    routed ones and the two named vendors all do tool calling, and asking
 *    them would spend the customer's money on a question we can answer for
 *    free. For `openai_compatible` it is one real completion of one token,
 *    with one tool offered and `tool_choice` forcing it.
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
import type { ModelCredentialProvider } from "@oxagen/oxagen/contracts/org.model_credential.shared";

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
   * The model to ask the tool-calling question of, for `openai_compatible`.
   * An OpenAI-compatible server may host several models with different
   * capabilities, so the question is asked of the one the organisation will
   * actually use — the balanced tier, which the assistant runs on.
   */
  readonly toolProbeModel?: string | null;
}

export interface CredentialProbeResult {
  /** True when the vendor accepted the key. */
  readonly ok: boolean;
  /** Whole milliseconds from the first request to the last answer. */
  readonly latencyMs: number;
  /**
   * The vendor's message about the key when it was refused, `HTTP <status>`
   * when the vendor sent no message, or the transport error (network, DNS,
   * timeout) when no answer arrived. Null on success.
   */
  readonly error: string | null;
  /**
   * Whether the endpoint returned a tool call when forced to. `true` for the
   * providers known to support it (not asked), `null` when the key was
   * refused so the question never came up, and the observed answer for
   * `openai_compatible`.
   */
  readonly toolCalling: boolean | null;
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

/**
 * Ask an `openai_compatible` endpoint for a forced tool call and report
 * whether one came back. One token of output, one trivial tool, and
 * `tool_choice` naming it: a server that supports function calling has no
 * choice but to call it, so a plain-text answer is a clear "no".
 *
 * A non-2xx here is reported as `false` rather than as a key failure — the
 * key already passed question 1, so a refusal now is the endpoint declining
 * the `tools` parameter, which is exactly the answer being asked for. The
 * vendor's message is returned so the settings page can show WHY.
 */
async function probeToolCalling(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ supported: boolean; message: string | null }> {
  const response = await probeFetch(endpointUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
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
    }),
    signal: AbortSignal.timeout(CREDENTIAL_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { supported: false, message: await vendorMessage(response) };
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
  };
  const calls = body.choices?.[0]?.message?.tool_calls;
  return {
    supported: Array.isArray(calls) && calls.length > 0,
    message: null,
  };
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

    // Question 2, only where the answer is not already known.
    if (provider !== "openai_compatible") {
      return {
        ok: true,
        latencyMs: elapsedMs(startedAt),
        error: null,
        toolCalling: true,
      };
    }
    if (!args.toolProbeModel) {
      // The key works; the question cannot be asked without a model. The
      // handler refuses to save an openai_compatible credential with no
      // balanced-tier model, so this is a verify called on a partial form.
      return {
        ok: true,
        latencyMs: elapsedMs(startedAt),
        error: null,
        toolCalling: null,
      };
    }
    const tools = await probeToolCalling(
      args.baseUrl as string,
      apiKey,
      args.toolProbeModel,
    );
    return {
      ok: true,
      latencyMs: elapsedMs(startedAt),
      error: tools.message === null ? null : scrub(tools.message, apiKey),
      toolCalling: tools.supported,
    };
  } catch (err) {
    // A thrown fetch is transport: DNS, a refused connection, or the timeout
    // signal firing (a `TimeoutError` DOMException). Its message is the
    // operator's clue and carries no header, but it is scrubbed anyway.
    return fail(err instanceof Error ? err.message : String(err));
  }
}
