// fake-http.ts: a Transport that answers HTTP requests from a script, and a
// SendContext around it, for the HTTP, GraphQL, and MCP Senders' tests.
import { vi } from "vitest";
import type { ManifestAuth, ManifestServer, ManifestShaping } from "../../contract/manifest";
import { decodeText, encodeText } from "../body";
import type { SendContext, SendCredential } from "../sender";
import type {
  CallToolResult,
  HeaderEntry,
  HttpTransportRequest,
  HttpTransportResponse,
  LocalCall,
  Transport,
} from "../transport";

export interface FakeHttp {
  transport: Transport;
  requests: HttpTransportRequest[];
  locals: LocalCall[];
}

/** A Transport whose http() runs `answer` for each request and records it. */
export function fakeHttp(
  answer: (request: HttpTransportRequest, number: number) => Promise<HttpTransportResponse> | HttpTransportResponse,
  local: (call: LocalCall, number: number) => Promise<CallToolResult> = () =>
    Promise.reject(new Error("The test Transport has no local server.")),
): FakeHttp {
  const requests: HttpTransportRequest[] = [];
  const locals: LocalCall[] = [];
  return {
    requests,
    locals,
    transport: {
      http: async (request) => {
        requests.push(request);
        return answer(request, requests.length);
      },
      grpc: () => Promise.reject(new Error("The test Transport sends no gRPC.")),
      local: (call) => {
        locals.push(call);
        return local(call, locals.length);
      },
    },
  };
}

export type FakeResponse = HttpTransportResponse & { cancel: ReturnType<typeof vi.fn> };

/** A response with this status, body, and headers. An object body is sent as JSON. */
export function reply(status: number, body?: unknown, headers: HeaderEntry[] = []): FakeResponse {
  let bytes: Uint8Array;
  let sent = headers;
  if (body === undefined) bytes = new Uint8Array(0);
  else if (typeof body === "string") bytes = encodeText(body);
  else if (body instanceof Uint8Array) bytes = body;
  else {
    bytes = encodeText(JSON.stringify(body));
    if (!headers.some(([name]) => name.toLowerCase() === "content-type")) {
      sent = [["content-type", "application/json"], ...headers];
    }
  }
  return {
    status,
    headers: sent,
    body: (async function* () {
      if (bytes.byteLength > 0) yield bytes;
    })(),
    cancel: vi.fn(),
  };
}

/** A response whose body arrives as these chunks. */
export function streamed(status: number, chunks: readonly string[], headers: HeaderEntry[]): FakeResponse {
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield encodeText(chunk);
    })(),
    cancel: vi.fn(),
  };
}

/** The request body as text. */
export function bodyText(request: HttpTransportRequest): string {
  return decodeText(request.body);
}

/** The request body parsed as JSON. */
export function bodyJson(request: HttpTransportRequest): unknown {
  const value: unknown = JSON.parse(decodeText(request.body));
  return value;
}

/** A header's value in the request, in any case. */
export function header(request: HttpTransportRequest, name: string): string | undefined {
  return request.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function shaping(overrides: Partial<ManifestShaping> = {}): ManifestShaping {
  return {
    hide: [],
    fixed: {},
    defaults: {},
    rename: {},
    select: [],
    redact: [],
    max_result_bytes: 65_536,
    deadline_ms: 30_000,
    ...overrides,
  };
}

export interface ContextOptions {
  transport: Transport;
  url?: string | undefined;
  network?: string;
  auth?: ManifestAuth | null;
  credential?: SendCredential;
  shaping?: Partial<ManifestShaping>;
  idempotency_key?: string;
  signal?: AbortSignal;
  server?: ManifestServer;
}

/** A SendContext for a server at https://api.example.com/v2, unless the options say otherwise. */
export function sendContext(options: ContextOptions): SendContext {
  return {
    server: options.server ?? ({ name: "example" } as unknown as ManifestServer),
    environment: {
      name: "sandbox",
      url: "url" in options ? options.url : "https://api.example.com/v2",
      network: options.network ?? "cloud",
    },
    auth: options.auth ?? null,
    credential: options.credential ?? { type: "none" },
    transport: options.transport,
    shaping: shaping(options.shaping),
    idempotency_key: options.idempotency_key,
    signal: options.signal ?? new AbortController().signal,
  };
}
