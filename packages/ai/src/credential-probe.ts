/**
 * Ask a model vendor whether an API key is accepted, without spending tokens
 * (ADR-053 §2).
 *
 * Each vendor exposes a metadata read that is authenticated the same way a
 * completion is and costs nothing: OpenRouter's key endpoint reports the key's
 * own limits, and the Vercel AI Gateway's model list is gated on the key. A
 * 2xx from either is the vendor saying "this key works here"; anything else is
 * reported with the vendor's own text so an operator can fix the key rather
 * than guess.
 *
 * SECRET HANDLING: the key goes into one request header and nowhere else. It
 * is never logged, never part of a thrown error, and never part of the result
 * — a vendor message or a transport error that happened to echo the key is
 * scrubbed before it is returned.
 */

/** The vendors a key can be checked against — the `provider` column's CHECK. */
export type CredentialProbeProvider = "openrouter" | "gateway";

export interface ProbeModelCredentialArgs {
  readonly provider: CredentialProbeProvider;
  /** The plaintext key. Never log, never serialise. */
  readonly apiKey: string;
}

export interface CredentialProbeResult {
  /** True when the vendor answered 2xx. */
  readonly ok: boolean;
  /** Whole milliseconds from request to answer (or to the failure). */
  readonly latencyMs: number;
  /**
   * The vendor's message about the key when it was refused, `HTTP <status>`
   * when the vendor sent no message, or the transport error (network, DNS,
   * timeout) when no answer arrived. Null on success.
   */
  readonly error: string | null;
}

/**
 * How long one probe may take. A vendor that has not answered in ten seconds
 * is not going to serve a completion either, and the settings page is waiting
 * on this behind a button.
 */
export const CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;

/** The token-free, key-authenticated endpoint per vendor. */
export const CREDENTIAL_PROBE_URL: Readonly<
  Record<CredentialProbeProvider, string>
> = {
  openrouter: "https://openrouter.ai/api/v1/auth/key",
  gateway: "https://ai-gateway.vercel.sh/v1/models",
};

const REDACTED = "[redacted]";

/** Whole milliseconds since `startedAt`, never negative. */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/**
 * Replace every occurrence of the key in a vendor or transport message. Both
 * are text we did not write, so neither is trusted not to echo the header.
 */
function scrub(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join(REDACTED) : text;
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

/**
 * Check one key against its vendor. Never throws: a refusal, a timeout and a
 * network failure are all answers the caller reports, and the settings page
 * shows the operator whichever one came back.
 */
export async function probeModelCredential({
  provider,
  apiKey,
}: ProbeModelCredentialArgs): Promise<CredentialProbeResult> {
  const startedAt = performance.now();
  try {
    const response = await fetch(CREDENTIAL_PROBE_URL[provider], {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CREDENTIAL_PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      return { ok: true, latencyMs: elapsedMs(startedAt), error: null };
    }
    const message = await vendorMessage(response);
    return {
      ok: false,
      latencyMs: elapsedMs(startedAt),
      error: scrub(message, apiKey),
    };
  } catch (err) {
    // A thrown fetch is transport: DNS, a refused connection, or the timeout
    // signal firing (a `TimeoutError` DOMException). Its message is the
    // operator's clue and carries no header, but it is scrubbed anyway.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs: elapsedMs(startedAt),
      error: scrub(message, apiKey),
    };
  }
}
