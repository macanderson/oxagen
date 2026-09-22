/**
 * Unit tests for the run recorder routes (#2952, ADR-058):
 *   run.frame_body.get, run.transcript.get, run.bisect, run.fork,
 *   run.export, run.export.get, run.summarize
 *
 * Pattern: mock at the adapter seam (@oxagen/auth, @oxagen/oxagen/kernel,
 * @oxagen/billing, @oxagen/handlers, middleware/logger); assert the happy
 * path forwards the invoke result as JSON, invoke is called once with the
 * contract name, the parsed body and surface "api", and an input the
 * contract refuses is a 400 that never reaches invoke.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...real,
    invoke: mocks.invoke,
    clearHandlersForTests: vi.fn(),
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function rawPost(path: string, body: string): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
});

interface RouteCase {
  path: string;
  contract: string;
  /** An input the contract accepts, as the wire carries it. */
  input: Record<string, unknown>;
  /**
   * What the handler is called with, where the contract fills a default the
   * wire body left out. Omitted when the parsed body is the body as sent.
   */
  parsed?: Record<string, unknown>;
  /** What a handler answers; the route forwards it verbatim. */
  output: Record<string, unknown>;
  /** Inputs the contract refuses, each named by what is wrong with it. */
  refused: Record<string, Record<string, unknown>>;
}

const CASES: RouteCase[] = [
  {
    path: "/runs/proof",
    contract: "get_run_proof",
    input: { runId: TACHO_ID },
    output: {
      runId: TACHO_ID,
      verdict: null,
      witnesses: [],
      witnessRuns: [],
      disclosureGrain: "L0",
    },
    refused: {
      "run id of neither store": { runId: "wit_01K5RQ8M4" },
      "unknown field": { runId: TACHO_ID, witnessId: "wit_1" },
    },
  },
  {
    path: "/runs/frame-body",
    contract: "get_run_frame_body",
    input: { runId: LEDGER_ID, seq: "7" },
    output: {
      contentType: "text/plain",
      bytes: "aGVsbG8=",
      digest: `sha256:${"a".repeat(64)}`,
      redactions: [],
    },
    refused: {
      "seq that is not a decimal": { runId: LEDGER_ID, seq: "seven" },
      "run id of neither store": { runId: "run_1", seq: "1" },
      "unknown field": { runId: LEDGER_ID, seq: "1", bytes: true },
    },
  },
  {
    path: "/runs/transcript",
    contract: "get_run_transcript",
    input: { runId: TACHO_ID, zoom: "steps" },
    // `kinds` and `limit` carry contract defaults, so the handler is called
    // with more than the wire sent. Asserting the sent body here would have
    // the route look like it forwards the body unparsed.
    parsed: { runId: TACHO_ID, zoom: "steps", kinds: [], limit: 200 },
    output: { entries: [], complete: true },
    refused: {
      "zoom outside the three levels": { runId: TACHO_ID, zoom: "frames" },
      "missing zoom": { runId: TACHO_ID },
    },
  },
  {
    path: "/runs/bisect",
    contract: "bisect_runs",
    input: { runA: LEDGER_ID, runB: TACHO_ID },
    output: { divergentSeq: null, keyA: null, keyB: null, aligned: 3 },
    refused: {
      "one run only": { runA: LEDGER_ID },
      "run id of neither store": { runA: LEDGER_ID, runB: "sess-2" },
    },
  },
  {
    path: "/runs/fork",
    contract: "fork_run",
    input: { runId: LEDGER_ID, fromSeq: "2" },
    output: { attemptId: "arat_forkforkforkforkforkfo", attemptNumber: 2 },
    refused: {
      "an attempt id in place of a run id": {
        runId: "arat_0123456789abcdefghjkmn",
        fromSeq: "2",
      },
      "fromSeq of 0": { runId: LEDGER_ID, fromSeq: "0" },
    },
  },
  {
    path: "/runs/export",
    contract: "export_run",
    input: { runId: LEDGER_ID },
    output: { exportId: "rex_0123456789abcdefghjkmn", status: "queued" },
    refused: {
      "run id of neither store": { runId: "arun-1" },
      "unknown field": { runId: LEDGER_ID, format: "zip" },
    },
  },
  {
    path: "/runs/export-status",
    contract: "get_run_export",
    input: { exportId: "rexp_0123456789abcdefghjkmn" },
    output: {
      exportId: "rexp_0123456789abcdefghjkmn",
      runId: LEDGER_ID,
      status: "building",
      createdAt: "2026-09-22T11:58:00.000Z",
      completedAt: null,
      bundleDigest: null,
      bundleBytes: null,
      merkleRoot: null,
      frameCount: null,
      error: null,
      download: null,
    },
    refused: {
      "a run id in place of an export id": { exportId: LEDGER_ID },
      "unknown field": {
        exportId: "rexp_0123456789abcdefghjkmn",
        runId: LEDGER_ID,
      },
    },
  },
  {
    path: "/runs/summarize",
    contract: "summarize_run",
    input: { runId: TACHO_ID },
    output: { runId: TACHO_ID, status: "queued" },
    refused: {
      "missing run id": {},
      "run id of neither store": { runId: "tse-1" },
    },
  },
];

for (const routeCase of CASES) {
  describe(`${routeCase.contract} route`, () => {
    it("happy path: forwards the invoke result as 200 JSON", async () => {
      mocks.invoke.mockResolvedValue(routeCase.output);
      const res = await app.fetch(post(routeCase.path, routeCase.input));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(routeCase.output);
    });

    it(`calls invoke once with contract name '${routeCase.contract}', the parsed body and surface 'api'`, async () => {
      mocks.invoke.mockResolvedValue(routeCase.output);
      await app.fetch(post(routeCase.path, routeCase.input));
      expect(mocks.invoke).toHaveBeenCalledOnce();
      const call = mocks.invoke.mock.calls[0];
      expect(call?.[0]).toBe(routeCase.contract);
      expect(call?.[1]).toEqual(routeCase.parsed ?? routeCase.input);
      expect(call?.[3]).toEqual({ surface: "api" });
    });

    for (const [why, refused] of Object.entries(routeCase.refused)) {
      it(`${why} → 400, invoke not called (negative)`, async () => {
        const res = await app.fetch(post(routeCase.path, refused));
        expect(res.status).toBe(400);
        expect(mocks.invoke).not.toHaveBeenCalled();
      });
    }

    it("invalid JSON body → 400, invoke not called (negative)", async () => {
      const res = await app.fetch(rawPost(routeCase.path, "{not json"));
      expect(res.status).toBe(400);
      expect(mocks.invoke).not.toHaveBeenCalled();
    });
  });
}
