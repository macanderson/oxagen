/**
 * The host's HTTPS client to the control plane (spec section 3.1 steps 3
 * and 4; section 7.4). Three machine-to-machine calls, each authenticated by
 * the host API key and validated against the wire schemas. `fetch` is
 * injected so tests run against a fake control plane.
 */
import {
  type BundleResponse,
  bundleResponseSchema,
  type CommandAcknowledgement,
  type CommandsResponse,
  commandsResponseSchema,
  type DaemonHealth,
  type IngestResponse,
  ingestResponseSchema,
  type TachoBatch,
} from "../wire";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export class ControlError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `control plane answered ${status}: ${body.slice(0, 256)}`);
    this.name = "ControlError";
    this.status = status;
    this.body = body;
  }
}

export class ControlUnreachable extends Error {
  constructor(cause: unknown) {
    super(
      `control plane unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ControlUnreachable";
  }
}

export interface ControlClientOptions {
  endpoints: { ingest: string; bundle: string; commands: string };
  apiKey: string;
  hostEnrollmentId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

export interface ControlClient {
  ingest: (
    events: TachoBatch["events"],
    daemon?: DaemonHealth,
  ) => Promise<IngestResponse>;
  bundle: (etag?: string) => Promise<BundleResponse>;
  commands: (
    acknowledgements?: CommandAcknowledgement[],
    daemon?: Omit<DaemonHealth, "spool_oldest_at" | "bundle_etag">,
  ) => Promise<CommandsResponse>;
}

export function createControlClient(
  options: ControlClientOptions,
): ControlClient {
  const fetchImpl: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init) as never);
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function post(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": options.userAgent ?? "tachod",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ControlUnreachable(error);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) throw new ControlError(response.status, text);
    try {
      return JSON.parse(text);
    } catch {
      throw new ControlError(
        response.status,
        text,
        "control plane answered non-JSON",
      );
    }
  }

  return {
    ingest: async (events, daemon) =>
      ingestResponseSchema.parse(
        await post(options.endpoints.ingest, {
          schema: "tacho.batch.v1",
          host_enrollment_id: options.hostEnrollmentId,
          events,
          ...(daemon !== undefined ? { daemon } : {}),
        }),
      ),
    bundle: async (etag) =>
      bundleResponseSchema.parse(
        await post(options.endpoints.bundle, {
          host_enrollment_id: options.hostEnrollmentId,
          ...(etag !== undefined ? { etag } : {}),
        }),
      ),
    commands: async (acknowledgements = [], daemon) =>
      commandsResponseSchema.parse(
        await post(options.endpoints.commands, {
          host_enrollment_id: options.hostEnrollmentId,
          acknowledgements,
          ...(daemon !== undefined ? { daemon } : {}),
        }),
      ),
  };
}
