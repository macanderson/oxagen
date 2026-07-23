/**
 * The sidecar transport (oxagen #1072): drives one round trip against a
 * running `stella serve` process over its headless HTTP+SSE surface
 * (stella#258) — session open, one turn, event stream, close.
 *
 * This is intentionally the smallest possible client: it exists so the
 * smoke test can prove the wire contract, not to be oxagen's production
 * sidecar integration (that lives in the platform's agent-runner once
 * ADR-033 Track 2 lands — see docs/adr/ADR-033-stella-engine-core.md and
 * docs/specs/agent-engine-v2/). Keep it dependency-free (fetch + node:http
 * only) so it stays easy to keep in lockstep with stella's serve surface.
 */

export interface SidecarClientOptions {
  /** Base URL of a running `stella serve` process, e.g. http://127.0.0.1:4180. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface TurnResult {
  events: import("./wire-types.js").StellaEventEnvelope[];
}

export class StellaSidecarClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SidecarClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Opens a new session. Returns the session id the engine assigned. */
  async createSession(): Promise<{ sessionId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(
        `createSession failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as {
      session_id?: string;
      sessionId?: string;
    };
    const sessionId = body.session_id ?? body.sessionId;
    if (!sessionId) {
      throw new Error(
        `createSession response missing session id: ${JSON.stringify(body)}`,
      );
    }
    return { sessionId };
  }

  /**
   * Opens the session's event stream (Server-Sent Events, one JSON
   * `StellaEventEnvelope` per `data:` line — the stream-json AgentEvent
   * vocabulary, per docs/specs/agent-engine-v2/spec.md §2.6) and collects
   * every event up to and including the first terminal `complete` event.
   */
  async openEventStream(
    sessionId: string,
  ): Promise<AsyncIterable<import("./wire-types.js").StellaEventEnvelope>> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/sessions/${sessionId}/events`,
      {
        headers: { accept: "text/event-stream" },
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`openEventStream failed: ${res.status}`);
    }
    return parseSseJsonLines(res.body);
  }

  /** Sends one turn (a single prompt) into the session. */
  async driveTurn(sessionId: string, prompt: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      },
    );
    if (!res.ok) {
      throw new Error(`driveTurn failed: ${res.status} ${await res.text()}`);
    }
  }

  /** Closes the session. */
  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${sessionId}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`deleteSession failed: ${res.status}`);
    }
  }
}

/** Parses an SSE byte stream of `data: <json>\n\n` frames into events. */
async function* parseSseJsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<import("./wire-types.js").StellaEventEnvelope> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice("data:".length).trim();
          if (payload.length > 0) {
            yield JSON.parse(
              payload,
            ) as import("./wire-types.js").StellaEventEnvelope;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
