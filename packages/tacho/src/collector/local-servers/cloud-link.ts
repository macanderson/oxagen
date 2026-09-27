/**
 * The local gateway's link to Oxagen's cloud gateway for local servers
 * (mcp-studio-spec, Local servers).
 *
 * The machine dials out and the cloud never dials in. The local gateway
 * long-polls for the next delivery and posts each reply, and both requests
 * carry the machine's API key. Any failure on either request is the cloud
 * gateway being unreachable: the local gateway runs nothing it did not
 * receive, and it keeps no reply to send later.
 */
import { cloudUnreachable, LocalServerError } from "./errors";
import { deliverySchema, type Delivery, type Reply } from "./wire";

/** Where the local gateway asks for its next delivery. */
export const LOCAL_SERVERS_NEXT_PATH = "/v1/local-servers/next";

/** Where the local gateway posts its replies. */
export const LOCAL_SERVERS_REPLY_PATH = "/v1/local-servers/replies";

/** Longer than the cloud's 25-second long-poll, so an empty poll ends on the cloud's side. */
export const DEFAULT_NEXT_TIMEOUT_MS = 40_000;

export const DEFAULT_REPLY_TIMEOUT_MS = 30_000;

export interface CloudResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The subset of `fetch` the link uses. */
export type CloudFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<CloudResponse>;

export interface CloudLinkOptions {
  /** The cloud gateway's origin, such as https://api.oxagen.sh. */
  baseUrl: string;
  /** The machine's API key, from enrollment. */
  apiKey: string;
  /** This machine's id: the host file's host_enrollment_id. */
  machine: string;
  fetch: CloudFetch;
  nextTimeoutMs?: number;
  replyTimeoutMs?: number;
}

export interface CloudLink {
  /** The next delivery, or undefined when none came before the long-poll ended. */
  next(signal?: AbortSignal): Promise<Delivery | undefined>;
  reply(reply: Reply): Promise<void>;
}

/** A cloud_unreachable error whose cause says what went wrong. */
function unreachable(detail: string): LocalServerError {
  const error = new LocalServerError(cloudUnreachable());
  error.cause = detail;
  return error;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCloudLink(options: CloudLinkOptions): CloudLink {
  const base = options.baseUrl.replace(/\/+$/, "");
  const nextTimeoutMs = options.nextTimeoutMs ?? DEFAULT_NEXT_TIMEOUT_MS;
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;

  async function send(
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; text: string }> {
    const limit = AbortSignal.timeout(timeoutMs);
    try {
      const response = await options.fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
          "User-Agent": "oxagen-local-gateway",
          "X-Tacho-Host": options.machine,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        signal: signal === undefined ? limit : AbortSignal.any([signal, limit]),
      });
      if (!response.ok) throw new Error(`it answered ${method} ${path} with ${response.status}`);
      return { status: response.status, text: await response.text() };
    } catch (error) {
      throw unreachable(errorText(error));
    }
  }

  return {
    async next(signal) {
      const response = await send("GET", LOCAL_SERVERS_NEXT_PATH, undefined, nextTimeoutMs, signal);
      if (response.status === 204) return undefined;
      let body: unknown;
      try {
        body = JSON.parse(response.text) as unknown;
      } catch {
        throw unreachable("its delivery is not JSON");
      }
      const parsed = deliverySchema.safeParse(body);
      if (!parsed.success) throw unreachable(`its delivery does not parse (${parsed.error.message})`);
      return parsed.data;
    },
    async reply(reply) {
      await send("POST", LOCAL_SERVERS_REPLY_PATH, JSON.stringify(reply), replyTimeoutMs, undefined);
    },
  };
}
